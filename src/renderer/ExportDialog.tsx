// "Export for someone without Locus": choose what the folder carries, see exactly what goes in,
// then pick where to put it (UI spec §9.2).
import { useEffect, useState } from 'react';
import { basename } from '../core/link';
import type { ExportSummary } from '../shared/api';
import { api } from './api';
import { Icon } from './icons';

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
const count = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

interface Props {
  notePath: string;
  markdown: string;
  onExport(scope: 'linked' | 'workspace'): void;
  onClose(): void;
}

export function ExportDialog({ notePath, markdown, onExport, onClose }: Props) {
  const [scope, setScope] = useState<'linked' | 'workspace'>('linked');
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setError(null);
    api
      .planExport(notePath, markdown, scope)
      .then((s) => !cancelled && setSummary(s))
      .catch((e) => !cancelled && setError(String(e?.message ?? e).replace(/^Error invoking remote method 'api': (Error: )?/, '')));
    return () => {
      cancelled = true;
    };
  }, [scope]);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="locus-dialog export-dialog" style={{ width: 560 }} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="dialog-head"><h2>Send {basename(notePath)} to someone without Locus</h2></div>
        <div className="dialog-body" style={{ display: 'grid', gap: 14 }}>
          <div className="muted">
            They get a folder with one page to double-click. It opens in any recent browser, shows this note, and every link
            opens what it points at, at the exact spot. Nothing to install.
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>The folder should also hold, as plain files:</div>
            <label style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
              <input type="radio" checked={scope === 'linked'} onChange={() => setScope('linked')} />
              <span><b>Only the files this note links to</b> <span className="muted">· one folder, one pile</span></span>
            </label>
            <label style={{ display: 'flex', gap: 8 }}>
              <input type="radio" checked={scope === 'workspace'} onChange={() => setScope('workspace')} />
              <span><b>The whole workspace</b> <span className="muted">· folders kept, as a code tour needs</span></span>
            </label>
          </div>
          <div className="export-summary">
            {error && <div className="field-error">{error}</div>}
            {!summary && !error && <span className="muted">Working out what goes in…</span>}
            {summary && (
              <ul>
                <li>{count(summary.notes, 'note')}{summary.notes > 1 ? ', including the ones this one links to' : ''}</li>
                <li>
                  {count(summary.files, 'file')} the note cites
                  {summary.versions ? `, ${summary.versions} of them an older version` : ''}
                  {summary.outside ? `, ${summary.outside} from outside the workspace` : ''}
                </li>
                {summary.missing > 0 && (
                  <li className="warn">
                    <Icon name="x" size={12} /> {count(summary.missing, 'link')} whose file can't be found: it will say so instead of opening
                  </li>
                )}
                <li className="muted">About {size(summary.bytes)} in all</li>
              </ul>
            )}
          </div>
        </div>
        <div className="dialog-foot">
          <button className="outline" onClick={onClose}>Cancel</button>
          <div className="spacer" />
          <button className="primary" disabled={!summary || summary.tooBig} onClick={() => onExport(scope)}>
            Choose a folder…
          </button>
        </div>
      </div>
    </div>
  );
}
