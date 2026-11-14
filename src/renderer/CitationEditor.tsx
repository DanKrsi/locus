// Editing a link without ever showing markdown (UI spec §4.4): what it points at, which document
// and version, and where inside it, with a preview of what the reader will land on.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  basename,
  dirname,
  fileKind,
  formatSheetRef,
  formatTime,
  headings,
  parseSheetRef,
  parseTime,
  stem,
  type FileKind,
  type Heading,
  type Location,
} from '../core/link';
import { isCanvas } from '../core/canvas';
import type { Terminology, Version } from '../shared/api';
import { api } from './api';
import { Icon, kindIcon } from './icons';
import { buildPreview } from './notes/hoverCard';
import { longDate, term, versionBadge } from './terms';
import type { CiteTarget } from './viewers/types';

export type PlaceKind = 'file' | 'page' | 'area' | 'lines' | 'slide' | 'cells' | 'section' | 'time';

export interface CitationTarget {
  path: string;
  /** A past version, or undefined for the latest. */
  rev?: string;
  loc: Location;
  quote?: string;
}

const KIND_NAMES: Record<PlaceKind, string> = {
  file: 'The whole file',
  page: 'A page',
  area: 'An area on a page',
  lines: 'Lines',
  slide: 'A slide',
  cells: 'Cells',
  section: 'A section',
  time: 'A time',
};

/** What a kind of file can be pointed at. */
export function kindsFor(kind: FileKind, path: string): PlaceKind[] {
  if (isCanvas(path)) return ['file'];
  switch (kind) {
    case 'pdf':
      return ['page', 'area', 'file'];
    case 'code':
      return ['lines', 'file'];
    case 'markdown':
      return ['section', 'lines', 'file'];
    case 'sheet':
      return ['cells', 'file'];
    case 'slides':
      return ['slide', 'file'];
    case 'media':
      return ['time', 'file'];
    default:
      return ['file'];
  }
}

/** Which files can hold a kind of place, for the Change… picker. */
export function acceptsPlace(place: PlaceKind): (path: string) => boolean {
  return (path: string) => {
    if (isCanvas(path)) return place === 'file';
    const k = fileKind(path);
    switch (place) {
      case 'page':
      case 'area':
        return k === 'pdf';
      case 'lines':
        return k === 'code' || k === 'markdown';
      case 'section':
        return k === 'markdown';
      case 'cells':
        return k === 'sheet';
      case 'slide':
        return k === 'slides';
      case 'time':
        return k === 'media';
      default:
        return true;
    }
  };
}

function kindOf(loc: Location): PlaceKind {
  if (loc.viewrect) return 'area';
  if (loc.page !== undefined) return 'page';
  if (loc.lines) return 'lines';
  if (loc.slide !== undefined) return 'slide';
  if (loc.sheet) return 'cells';
  if (loc.heading) return 'section';
  if (loc.time !== undefined) return 'time';
  return 'file';
}

interface Props {
  initial: CitationTarget;
  /** Hidden while the place is being picked in the document, or a file chosen. */
  hidden: boolean;
  terminology: Terminology;
  /** Lets the user choose the place in the viewer on the right; null when they cancel. */
  onPickInDocument(target: CitationTarget): Promise<CiteTarget | null>;
  /** Opens the file browser; null when they cancel. */
  onChangeDocument(current: CitationTarget, accept: (path: string) => boolean): Promise<{ path: string; rev?: string } | null>;
  onSave(target: CitationTarget): void;
  onClose(): void;
}

export function CitationEditor(p: Props) {
  const [path, setPath] = useState(p.initial.path);
  const [rev, setRev] = useState(p.initial.rev);
  const [kind, setKind] = useState<PlaceKind>(kindOf(p.initial.loc));
  const [loc, setLoc] = useState<Location>(p.initial.loc);
  /** The quote the link carries; dropped when the place is typed by hand, replaced when picked. */
  const [quote, setQuote] = useState(p.initial.quote);
  const [versions, setVersions] = useState<Version[]>([]);
  const [noteHeadings, setNoteHeadings] = useState<Heading[]>([]);
  const [preview, setPreview] = useState<HTMLElement | 'loading' | null>('loading');
  const previewHost = useRef<HTMLDivElement>(null);

  const kinds = kindsFor(fileKind(path), path);
  useEffect(() => {
    if (!kinds.includes(kind)) {
      setKind(kinds[0]);
      setLoc(kinds[0] === 'file' ? {} : {});
    }
  }, [path]);

  useEffect(() => {
    void api.versions(path).then(setVersions).catch(() => setVersions([]));
    if (fileKind(path) === 'markdown') void api.readText(path).then((t) => setNoteHeadings(headings(t))).catch(() => setNoteHeadings([]));
  }, [path]);

  // What the link will point at, as the reader will see it.
  useEffect(() => {
    let cancelled = false;
    setPreview('loading');
    buildPreview(loc, { path, external: false, rev })
      .then((node) => !cancelled && setPreview(node))
      .catch(() => !cancelled && setPreview(null));
    return () => {
      cancelled = true;
    };
  }, [path, rev, JSON.stringify(loc)]);
  useEffect(() => {
    const host = previewHost.current;
    if (!host) return;
    host.replaceChildren(preview instanceof HTMLElement ? preview : '');
  }, [preview]);

  const problem = (): string | null => {
    const n = (v?: number) => v !== undefined && Number.isInteger(v) && v >= 1;
    switch (kind) {
      case 'page':
        return n(loc.page) ? null : 'Give a page number';
      case 'area':
        return !n(loc.page) ? 'Give a page number' : loc.viewrect ? null : 'Use “Pick in the document” to draw the area';
      case 'lines':
        return loc.lines && loc.lines.start >= 1 && loc.lines.end >= loc.lines.start ? null : 'Give a first and last line';
      case 'slide':
        return n(loc.slide) ? null : 'Give a slide number';
      case 'cells':
        return loc.sheet?.range ? null : 'Give a range like B4:D12, or a named range';
      case 'section':
        return loc.heading ? null : 'Choose a section';
      case 'time':
        return loc.time !== undefined && loc.time >= 0 ? null : 'Give a time like 2:15';
      default:
        return null;
    }
  };
  const stop = problem();

  const changeKind = (next: PlaceKind) => {
    setKind(next);
    // Keep what carries over (the page of an area, the sheet of a range); drop the rest.
    setLoc((old) => {
      switch (next) {
        case 'page':
          return { page: old.page ?? 1 };
        case 'area':
          return { page: old.page ?? 1, viewrect: old.viewrect };
        case 'lines':
          return { lines: old.lines ?? { start: 1, end: 1 } };
        case 'slide':
          return { slide: old.slide ?? 1 };
        case 'cells':
          return { sheet: old.sheet ?? { range: '' } };
        case 'section':
          return { heading: old.heading };
        case 'time':
          return { time: old.time ?? 0 };
        default:
          return {};
      }
    });
  };

  const pick = async () => {
    const got = await p.onPickInDocument({ path, rev, loc, quote });
    if (!got) return;
    setLoc(got.loc);
    setKind(kindOf(got.loc));
    setQuote(got.quote);
  };

  const change = async () => {
    const got = await p.onChangeDocument({ path, rev, loc, quote }, acceptsPlace(kind));
    if (!got) return;
    setPath(got.path);
    setRev(got.rev);
    // Another document: the old place and quote belong to the old one.
    setQuote(undefined);
    if (got.path !== path) changeKind(kindsFor(fileKind(got.path), got.path)[0]);
  };

  /** Typing a place by hand leaves the old quote pointing at something else. */
  const place = (next: Location) => {
    setLoc(next);
    setQuote(undefined);
  };

  const folder = dirname(path);
  const label = useMemo(() => (kind === 'section' && loc.heading ? noteHeadings.find((h) => h.slug === loc.heading)?.text : undefined), [kind, loc.heading, noteHeadings]);
  const lines = loc.lines ?? { start: 1, end: 1 };

  return (
    <div className="backdrop" style={p.hidden ? { display: 'none' } : undefined} onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="locus-dialog citation-editor" style={{ width: 620 }} onKeyDown={(e) => e.key === 'Escape' && p.onClose()}>
        <div className="dialog-head"><h2>Edit this link</h2></div>
        <div className="dialog-body" style={{ display: 'grid', gap: 14 }}>
          <label className="ce-row">
            <span className="ce-label">Points at</span>
            <select value={kind} onChange={(e) => changeKind(e.target.value as PlaceKind)} aria-label="Points at">
              {kinds.map((k) => <option key={k} value={k}>{KIND_NAMES[k]}</option>)}
            </select>
          </label>

          <div className="ce-row">
            <span className="ce-label">Document</span>
            <span className="ce-chip">
              <Icon name={kindIcon(fileKind(path))} size={14} />
              <b>{basename(path)}</b>
              <span className="muted">{folder === '/' ? 'Workspace root' : folder.slice(1)}</span>
            </span>
            <button className="outline" onClick={() => void change()}>Change…</button>
          </div>

          <label className="ce-row">
            <span className="ce-label">Version</span>
            <select value={rev ?? ''} onChange={(e) => setRev(e.target.value || undefined)} aria-label="Version" style={{ maxWidth: 330 }}>
              <option value="">{term(p.terminology, 'latest')}</option>
              {versions.map((v) => (
                <option key={v.sha} value={v.sha.slice(0, 10)}>
                  {versionBadge(p.terminology, v.sha, v.date)} · {v.message}
                </option>
              ))}
            </select>
          </label>

          {kind !== 'file' && (
            <div className="ce-row">
              <span className="ce-label">Place</span>
              <span className="ce-place">
                {(kind === 'page' || kind === 'area') && (
                  <label>
                    Page <input type="number" min={1} aria-label="Page" value={loc.page ?? ''} onChange={(e) => place({ ...loc, page: Math.round(Number(e.target.value)) || undefined, viewrect: undefined })} />
                  </label>
                )}
                {kind === 'area' && <span className="muted">{loc.viewrect ? 'Area drawn' : 'No area yet'}</span>}
                {kind === 'lines' && (
                  <>
                    <label>
                      Lines <input type="number" min={1} aria-label="First line" value={lines.start} onChange={(e) => place({ lines: { start: Math.round(Number(e.target.value)), end: lines.end } })} />
                    </label>
                    <label>
                      – <input type="number" min={1} aria-label="Last line" value={lines.end} onChange={(e) => place({ lines: { start: lines.start, end: Math.round(Number(e.target.value)) } })} />
                    </label>
                  </>
                )}
                {kind === 'slide' && (
                  <label>
                    Slide <input type="number" min={1} aria-label="Slide" value={loc.slide ?? ''} onChange={(e) => place({ slide: Math.round(Number(e.target.value)) || undefined })} />
                  </label>
                )}
                {kind === 'cells' && (
                  <label style={{ flex: 1 }}>
                    Range <input aria-label="Range" style={{ width: 220 }} placeholder="Loads!B4:D12 or a named range" value={loc.sheet ? formatSheetRef(loc.sheet) : ''} onChange={(e) => place({ sheet: parseSheetRef(e.target.value) })} />
                  </label>
                )}
                {kind === 'section' && (
                  <select aria-label="Section" value={loc.heading ?? ''} onChange={(e) => place({ heading: e.target.value || undefined })} style={{ maxWidth: 330 }}>
                    <option value="">Choose a section…</option>
                    {noteHeadings.map((h) => <option key={h.slug} value={h.slug}>{'  '.repeat(h.level - 1)}{h.text}</option>)}
                  </select>
                )}
                {kind === 'time' && (
                  <label>
                    Time <input aria-label="Time" style={{ width: 90 }} placeholder="2:15" defaultValue={loc.time !== undefined ? formatTime(loc.time) : ''} onChange={(e) => place({ time: parseTime(e.target.value) })} />
                  </label>
                )}
                {kind !== 'section' && (
                  <button className="outline" onClick={() => void pick()} title="Choose the place in the document on the right">
                    <Icon name="area" size={13} /> Pick in the document
                  </button>
                )}
              </span>
            </div>
          )}

          <div className="ce-row ce-preview-row">
            <span className="ce-label">Lands on</span>
            <div className="ce-preview">
              <div ref={previewHost} className="preview" style={preview instanceof HTMLElement ? undefined : { display: 'none' }} />
              {preview === 'loading' && <span className="muted">Loading…</span>}
              {preview === null && <span className="muted">{label ?? (kind === 'file' ? stem(path) : 'No preview for this kind of place')}</span>}
            </div>
          </div>
          {stop && <div className="field-error">{stop}</div>}
        </div>
        <div className="dialog-foot">
          <button className="outline" onClick={p.onClose}>Cancel</button>
          <button className="primary" disabled={!!stop} onClick={() => p.onSave({ path, rev, loc, quote })}>Save</button>
        </div>
      </div>
    </div>
  );
}

export { longDate };
