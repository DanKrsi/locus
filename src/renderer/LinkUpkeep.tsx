// What the user sees of the link check that runs after a version is saved: a summary of what
// can follow by itself and what changed, and a bar for going through the changed ones.
import { useEffect, useState } from 'react';
import { basename, type Location } from '../core/link';
import { Icon } from './icons';
import type { CheckedLink } from './linkcheck';

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export type SummaryChoice = 'update' | 'each' | 'later';

/** How many links can follow, point at deleted files, or changed; and what to do about them. */
export function UpkeepSummary({ links, onChoose }: { links: CheckedLink[]; onChoose(c: SummaryChoice): void }) {
  const follow = links.filter((l) => l.verdict === 'follow').length;
  const deleted = links.filter((l) => l.verdict === 'deleted').length;
  const review = links.filter((l) => l.verdict === 'review').length;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onChoose('later');
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Nothing is the default button, so a stray Enter does nothing.
  return (
    <div className="backdrop">
      <div className="locus-dialog upkeep-summary" style={{ width: 520 }}>
        <div className="dialog-head"><h2>Links to files that changed</h2></div>
        <div className="dialog-body" style={{ display: 'grid', gap: 8 }}>
          <div className="muted">Files your notes link to have changed since they were cited.</div>
          {follow > 0 && (
            <div className="upkeep-row">
              <span className="dot ok" />
              <span><b>{plural(follow, 'link')}</b> can follow by {follow === 1 ? 'itself' : 'themselves'}: what {follow === 1 ? 'it cites' : 'they cite'} is unchanged or only moved.</span>
            </div>
          )}
          {review > 0 && (
            <div className="upkeep-row">
              <span className="dot warn" />
              <span><b>{plural(review, 'link')}</b> {review === 1 ? 'cites' : 'cite'} something that changed and {review === 1 ? 'needs' : 'need'} a look.</span>
            </div>
          )}
          {deleted > 0 && (
            <div className="upkeep-row">
              <span className="dot gone" />
              <span><b>{plural(deleted, 'link')}</b> {deleted === 1 ? 'points' : 'point'} at a deleted file and will keep showing the version {deleted === 1 ? 'it was' : 'they were'} cited from.</span>
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <button className="outline" onClick={() => onChoose('later')}>Not now</button>
          <div className="spacer" />
          <button className="outline" onClick={() => onChoose('each')}>Go through them one by one</button>
          {follow + deleted > 0 && (
            <button className="outline strong" onClick={() => onChoose('update')}>
              {review > 0 ? `Update the ${follow + deleted} and review the rest` : `Update ${follow + deleted === 1 ? 'the link' : `the ${follow + deleted} links`}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export type ReviewChoice = { kind: 'update'; loc?: Location } | { kind: 'selection' } | { kind: 'keep' } | { kind: 'skip' } | { kind: 'stop' };

/** The bar shown while going through links one by one; the documents themselves are in the panes. */
export function ReviewBar({ link, index, count, canSelect, onChoose }: { link: CheckedLink; index: number; count: number; canSelect: boolean; onChoose(c: ReviewChoice): void }) {
  const lines = link.next.loc.lines;
  const [from, setFrom] = useState(String(lines?.start ?? ''));
  const [to, setTo] = useState(String(lines?.end ?? ''));
  useEffect(() => {
    setFrom(String(lines?.start ?? ''));
    setTo(String(lines?.end ?? ''));
  }, [link]);
  const a = Math.round(Number(from));
  const b = Math.round(Number(to));
  const linesOk = !lines || (a >= 1 && b >= a);
  return (
    <div className="review-bar" role="region" aria-label="Review links">
      <div className="review-what">
        <Icon name="link" /> <b>Link {index + 1} of {count}</b>
        <span className="label">“{link.cite.label}”</span>
        <span className="muted">in {basename(link.cite.note)} · {link.reason}</span>
      </div>
      <div className="review-how muted">
        {link.verdict === 'follow' ? 'It can follow as it is.' : 'Left: what was cited. Right: the latest version, with the proposed place.'}
      </div>
      <div className="review-actions">
        {lines && (
          <span className="review-lines">
            Lines
            <input aria-label="First line" type="number" min={1} value={from} onChange={(e) => setFrom(e.target.value)} />
            –
            <input aria-label="Last line" type="number" min={1} value={to} onChange={(e) => setTo(e.target.value)} />
          </span>
        )}
        <button className="primary" disabled={!linesOk} onClick={() => onChoose({ kind: 'update', loc: lines ? { ...link.next.loc, lines: { start: a, end: b } } : undefined })}>
          Update the link
        </button>
        {canSelect && (
          <button className="outline" title="Select the new place in the document on the right (draw an area, pick cells, go to the page or slide), then press this" onClick={() => onChoose({ kind: 'selection' })}>
            Use what's selected on the right
          </button>
        )}
        <button className="outline" title="Pin the link to the version it was cited from; it won't ask again" onClick={() => onChoose({ kind: 'keep' })}>Keep the old version</button>
        <button className="outline" onClick={() => onChoose({ kind: 'skip' })}>Skip</button>
        <div className="spacer" />
        <button className="outline" onClick={() => onChoose({ kind: 'stop' })}><Icon name="x" /> Stop reviewing</button>
      </div>
    </div>
  );
}
