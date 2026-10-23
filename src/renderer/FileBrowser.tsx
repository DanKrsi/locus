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
  /** Moves a file or folder (latest version only); links to it are updated. */
  onRename(from: string, to: string): Promise<void>;
  /** "notes" lists notes for the left pane (latest only); "documents" lists everything for the viewer. */
  target: 'notes' | 'documents';
  onNewNote?(): void;
  /** Opens the version history (documents only). */
  onHistory?(): void;
}

export function FileBrowser(p: Props) {
  const [files, setFiles] = useState<Entry[]>([]);
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [reload, setReload] = useState(0);

  const commitRename = async () => {
    if (!renaming) return;
    const to = '/' + renaming.value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    const from = renaming.path;
    setRenaming(null);
    if (to !== from && to !== '/') {
      await p.onRename(from, to);
      setReload((r) => r + 1);
    }
  };

  /** Rename/move button, or the inline path editor while renaming. */
  const renameControl = (path: string) => {
    if (p.rev) return null;
    if (renaming?.path === path) {
      return (
        <input
          className="rename"
          autoFocus
          value={renaming.value}
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => {
            const v = e.target.value;
            const dot = v.lastIndexOf('.');
            e.target.setSelectionRange(v.lastIndexOf('/') + 1, dot > v.lastIndexOf('/') ? dot : v.length);
          }}
          onChange={(e) => setRenaming({ path, value: e.target.value })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') void commitRename();
            if (e.key === 'Escape') setRenaming(null);
          }}
          onBlur={() => setRenaming(null)}
        />
      );
    }
    return (
      <button
        className="icon row-action"
        title="Rename or move (links to it are updated)"
        onClick={(e) => {
          e.stopPropagation();
          setRenaming({ path, value: path.slice(1) });
        }}
      >
        <Icon name="edit" size={14} />
      </button>
    );
  };

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
  }, [p.rev, reload]);

  useEffect(() => inputRef.current?.focus(), []);

  // Esc closes the dialog even when focus has left it (e.g. after a rename).
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !renamingRef.current) p.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pool = useMemo(() => (p.target === 'notes' ? files.filter((f) => fileKind(f.path) === 'markdown') : files), [files, p.target]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter((f) => f.path.toLowerCase().includes(q)).sort((a, b) => {
      const an = basename(a.path).toLowerCase().includes(q) ? 0 : 1;
      const bn = basename(b.path).toLowerCase().includes(q) ? 0 : 1;
      return an - bn || a.path.localeCompare(b.path);
    });
  }, [pool, filter]);

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
          {f.mark !== 'notYet' && renameControl(f.path)}
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
            {renaming?.path === '/' + folder ? renameControl('/' + folder) : <span className="name">{parts[d - 1]}</span>}
            <span className="spacer" />
            {renaming?.path !== '/' + folder && renameControl('/' + folder)}
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
          {renaming?.path === f.path ? renameControl(f.path) : <span className="name">{basename(f.path)}</span>}
          <span className="spacer" />
          {markBadge(f.mark)}
          {f.mark !== 'notYet' && renaming?.path !== f.path && renameControl(f.path)}
        </div>,
      );
    }
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="locus-dialog" onKeyDown={(e) => e.key === 'Escape' && p.onClose()}>
        <div className="dialog-head">
          <h2>{p.target === 'notes' ? 'Open note' : 'Open document'}</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>{p.target === 'notes' ? 'opens on the left' : 'opens in the viewer on the right'}</span>
          <div className="spacer" />
          {p.target === 'documents' && <>
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
          </>}
        </div>
        <div style={{ padding: '0 16px 10px' }}>
          <input
            ref={inputRef}
            style={{ width: '100%' }}
            placeholder={p.target === 'notes' ? 'Find a note by name' : 'Find a file by name'}
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
          {rows.length ? rows : <div className="muted" style={{ padding: 8 }}>{p.target === 'notes' ? 'No notes match.' : 'No files match.'}</div>}
        </div>
        <div className="dialog-foot">
          {p.target === 'documents' && p.onHistory && (
            <button className="outline" onClick={p.onHistory} title="See what changed in each version">
              <Icon name="history" /> {term(p.terminology, 'history')}
            </button>
          )}
          {p.target === 'documents' ? (
            <button
              className="outline"
              onClick={async () => {
                const paths = await api.pickExternalFiles();
                if (paths.length) p.onOpenExternal(paths);
              }}
            >
              <Icon name="folderOpen" /> Browse this computer…
            </button>
          ) : (
            <button className="outline" onClick={p.onNewNote}>
              <Icon name="plus" /> New note
            </button>
          )}
          <div className="spacer" />
          <button className="outline" onClick={p.onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
