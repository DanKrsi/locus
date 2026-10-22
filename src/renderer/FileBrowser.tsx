import { useEffect, useMemo, useRef, useState } from 'react';
import { basename, fileKind } from '../core/link';
import type { FileChange, Terminology, Version } from '../shared/api';
import { api } from './api';
import { Icon, kindIcon } from './icons';
import { longDate, term } from './terms';

type Mark = 'changed' | 'deleted' | 'notYet' | 'new';

interface Entry {
  path: string;
  mark?: Mark;
}

interface Props {
  terminology: Terminology;
  versions: Version[];
  /** Version to browse (undefined = latest). */
  rev?: string;
  onRevChange(rev: string | undefined): void;
  onOpen(path: string, rev: string | undefined): void;
  onOpenExternal(paths: string[]): void;
  onClose(): void;
}

export function FileBrowser(p: Props) {
  const [files, setFiles] = useState<Entry[]>([]);
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const now = await api.listFiles();
      if (!p.rev) {
        const changes = await api.uncommitted().catch(() => [] as FileChange[]);
        const added = new Set(changes.filter((c) => c.kind === 'untracked' || c.kind === 'added').map((c) => c.path));
        if (!cancelled) setFiles(now.map((path) => ({ path, mark: added.has(path) ? 'new' : undefined })));
        return;
      }
      const then = await api.listFiles(p.rev);
      const changes = await api.changesSince(p.rev);
      const byPath = new Map<string, Mark>();
      for (const c of changes) {
        if (c.kind === 'modified') byPath.set(c.path, 'changed');
        else if (c.kind === 'deleted') byPath.set(c.path, 'deleted');
        else if (c.kind === 'renamed' && c.from) byPath.set(c.from, 'deleted');
      }
      const thenSet = new Set(then);
      const entries: Entry[] = then.map((path) => ({ path, mark: byPath.get(path) }));
      for (const path of now) if (!thenSet.has(path)) entries.push({ path, mark: 'notYet' });
      entries.sort((a, b) => a.path.localeCompare(b.path));
      if (!cancelled) setFiles(entries);
    })();
    return () => {
      cancelled = true;
    };
  }, [p.rev]);

  useEffect(() => inputRef.current?.focus(), []);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q)).sort((a, b) => {
      const an = basename(a.path).toLowerCase().includes(q) ? 0 : 1;
      const bn = basename(b.path).toLowerCase().includes(q) ? 0 : 1;
      return an - bn || a.path.localeCompare(b.path);
    });
  }, [files, filter]);

  const openable = shown.filter((f) => f.mark !== 'notYet');
  const open = (e: Entry) => {
    if (e.mark === 'notYet') return;
    p.onOpen(e.path, p.rev);
  };

  const markBadge = (m?: Mark) => {
    if (m === 'changed') return <span className="badge mark">{term(p.terminology, 'changedSince')}</span>;
    if (m === 'deleted') return <span className="badge danger">{term(p.terminology, 'deletedLater')}</span>;
    if (m === 'notYet') return <span className="muted" style={{ fontSize: 12 }}>· {term(p.terminology, 'notYet')}</span>;
    if (m === 'new') return <span className="badge accent">{term(p.terminology, 'newSince')}</span>;
    return null;
  };

  // Flat list when filtering, folder tree otherwise.
  const rows: React.ReactNode[] = [];
  if (filter.trim()) {
    shown.forEach((f, i) =>
      rows.push(
        <div
          key={f.path}
          className={'tree-row' + (f.mark === 'notYet' ? ' ghost' : '')}
          style={openable[cursor] === f ? { background: 'var(--accent-soft)' } : undefined}
          onClick={() => open(f)}
        >
          <Icon name={kindIcon(fileKind(f.path))} />
          <span className="name">{basename(f.path)}</span>
          <span className="muted" style={{ fontSize: 12 }}>{f.path.slice(1, -basename(f.path).length - 1)}</span>
          <span className="spacer" />
          {markBadge(f.mark)}
        </div>,
      ),
    );
  } else {
    const seen = new Set<string>();
    for (const f of shown) {
      const parts = f.path.split('/').slice(1);
      for (let d = 1; d < parts.length; d++) {
        const folder = parts.slice(0, d).join('/');
        if (seen.has(folder)) continue;
        seen.add(folder);
        rows.push(
          <div key={'d:' + folder} className="tree-row folder" style={{ paddingLeft: 8 + (d - 1) * 18 }}>
            <Icon name="folder" />
            <span className="name">{parts[d - 1]}</span>
          </div>,
        );
      }
      rows.push(
        <div
          key={f.path}
          className={'tree-row' + (f.mark === 'notYet' ? ' ghost' : '')}
          style={{ paddingLeft: 8 + (parts.length - 1) * 18 }}
          onClick={() => open(f)}
        >
          <Icon name={kindIcon(fileKind(f.path))} />
          <span className="name">{basename(f.path)}</span>
          <span className="spacer" />
          {markBadge(f.mark)}
        </div>,
      );
    }
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="dialog" onKeyDown={(e) => e.key === 'Escape' && p.onClose()}>
        <div className="dialog-head">
          <h2>Open file</h2>
          <div className="spacer" />
          <span className="muted" style={{ fontSize: 12.5 }}>{term(p.terminology, 'showFolderAs')}</span>
          <select value={p.rev ?? ''} onChange={(e) => p.onRevChange(e.target.value || undefined)} style={{ maxWidth: 280 }}>
            <option value="">{term(p.terminology, 'latest')}</option>
            {p.versions.map((v) => (
              <option key={v.sha} value={v.sha}>
                {p.terminology === 'git' ? `${v.sha.slice(0, 7)} · ` : ''}
                {longDate(v.date)} · {v.message}
              </option>
            ))}
          </select>
        </div>
        <div style={{ padding: '0 16px 10px' }}>
          <input
            ref={inputRef}
            style={{ width: '100%' }}
            placeholder="Find a file by name"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, openable.length - 1));
              else if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0));
              else if (e.key === 'Enter' && openable[cursor]) open(openable[cursor]);
            }}
          />
        </div>
        <div className="dialog-body tree" style={{ minHeight: 280 }}>
          {rows.length ? rows : <div className="muted" style={{ padding: 8 }}>No files match.</div>}
        </div>
        <div className="dialog-foot">
          <button
            className="outline"
            onClick={async () => {
              const paths = await api.pickExternalFiles();
              if (paths.length) p.onOpenExternal(paths);
            }}
          >
            <Icon name="folderOpen" /> Browse this computer…
          </button>
          <div className="spacer" />
          <button className="outline" onClick={p.onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
