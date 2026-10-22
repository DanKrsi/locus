// The workspace's version history: what each version changed, with ways into it
// (open a changed file as it was, or browse every file from that version).
import { useEffect, useState } from 'react';
import { basename, fileKind } from '../core/link';
import type { FileChange, Terminology, Version } from '../shared/api';
import { api } from './api';
import { Icon, kindIcon } from './icons';
import { longDate, term } from './terms';

const KIND_LABEL: Record<FileChange['kind'], [string, string]> = {
  added: ['added', 'accent'],
  modified: ['changed', 'mark'],
  deleted: ['deleted', 'danger'],
  renamed: ['moved', 'muted'],
  untracked: ['new', 'accent'],
};

export function HistoryDialog({
  versions,
  terminology,
  onOpenFile,
  onBrowse,
  onClose,
}: {
  versions: Version[];
  terminology: Terminology;
  onOpenFile(path: string, sha: string): void;
  onBrowse(sha: string): void;
  onClose(): void;
}) {
  const [selected, setSelected] = useState<string | null>(versions[0]?.sha ?? null);
  const [changes, setChanges] = useState<FileChange[] | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!selected) return;
    setChanges(null);
    api.versionChanges(selected).then(setChanges, () => setChanges([]));
  }, [selected]);

  const git = terminology === 'git';
  const current = versions.find((v) => v.sha === selected);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog history-dialog">
        <div className="dialog-head">
          <h2>{term(terminology, 'history')}</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>{versions.length} {git ? 'commits' : 'versions'}</span>
        </div>
        <div className="history-cols">
          <div className="history-list">
            {versions.length === 0 && <div className="muted" style={{ padding: 8 }}>No versions yet.</div>}
            {versions.map((v) => (
              <button key={v.sha} className={'history-item' + (v.sha === selected ? ' selected' : '')} onClick={() => setSelected(v.sha)}>
                <span className="msg">
                  {git && <span className="mono sha">{v.sha.slice(0, 7)}</span>}
                  {v.message}
                </span>
                <span className="when">
                  {longDate(v.date)}
                  {v.auto && <span className="badge muted">{git ? 'auto-commit' : 'automatic'}</span>}
                </span>
              </button>
            ))}
          </div>
          <div className="history-detail">
            {current && (
              <>
                <div className="detail-head">
                  <div style={{ fontWeight: 600 }}>{current.message}</div>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {longDate(current.date)}
                    {git && <> · <span className="mono">{current.sha.slice(0, 10)}</span></>}
                  </div>
                </div>
                <div className="muted" style={{ fontSize: 12.5, margin: '10px 0 4px' }}>
                  {changes === null ? 'Loading…' : changes.length === 0 ? 'No file changes in this version.' : 'What changed (click a file to open it as it was):'}
                </div>
                {changes?.map((c) => {
                  const [label, tone] = KIND_LABEL[c.kind];
                  const openable = c.kind !== 'deleted';
                  return (
                    <div
                      key={c.path}
                      className={'tree-row' + (openable ? '' : ' ghost')}
                      title={openable ? `Open ${c.path.slice(1)} as it was in this version` : 'Deleted in this version'}
                      onClick={() => openable && onOpenFile(c.path, current.sha)}
                    >
                      <Icon name={kindIcon(fileKind(c.path))} />
                      <span className="name">{basename(c.path)}</span>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {c.kind === 'renamed' && c.from ? `from ${c.from.slice(1)}` : c.path.slice(1, -basename(c.path).length - 1)}
                      </span>
                      <span className="spacer" />
                      <span className={`badge ${tone}`}>{label}</span>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
        <div className="dialog-foot">
          <button className="outline" style={{ marginRight: 'auto' }} onClick={onClose}>Close</button>
          {current && (
            <button className="primary" onClick={() => onBrowse(current.sha)}>
              <Icon name="folderOpen" /> Browse all files from this version
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
