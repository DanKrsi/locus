import { useCallback, useEffect, useRef, useState } from 'react';
import {
  basename,
  defaultLabel,
  fileKind,
  formatReference,
  resolvePath,
  type Location,
  type Reference,
} from '../core/link';
import { mapLines } from '../core/remap';
import type { Settings, Version, WorkspaceInfo } from '../shared/api';
import { api, shortSha } from './api';
import { DocsPane } from './docs/DocsPane';
import { FileBrowser } from './FileBrowser';
import { invalidateLatest } from './files';
import { Icon, Logo } from './icons';
import { newId, revealOf, type DocTab } from './model';
import { allLinks, insertReference, type LinkInfo, type RefStatus } from './notes/editor';
import { renderHoverCard } from './notes/hoverCard';
import { NotesPane, type NotesHandle } from './notes/NotesPane';
import { longDate, term, versionBadge } from './terms';
import type { ViewerHandle } from './viewers/types';

interface Session {
  notes: string[];
  activeNote: string | null;
  docs: { path: string; external: boolean; rev?: string }[];
  activeDoc: number;
}

interface Notice {
  text: string;
  danger?: boolean;
  action?: { label: string; run(): void };
}

const THEMES = [
  { id: 'forest', name: 'Forest', colors: ['#1f5c45', '#8db596', '#c9a227'] },
  { id: 'ocean', name: 'Ocean', colors: ['#1d4f91', '#7fa3d1', '#d68c1e'] },
  { id: 'plum', name: 'Plum', colors: ['#5b3a82', '#b39ccf', '#c85a78'] },
  { id: 'terracotta', name: 'Terracotta', colors: ['#9c4221', '#d8a48c', '#1e8c82'] },
  { id: 'slate', name: 'Slate', colors: ['#36414d', '#9aa6b2', '#d4aa00'] },
];

const sessionKey = (root: string) => `session:${root}`;
const sameRev = (a?: string, b?: string) => (!a && !b) || (!!a && !!b && (a.startsWith(b) || b.startsWith(a)));

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [ws, setWs] = useState<WorkspaceInfo | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [versionsKey, setVersionsKey] = useState(0);
  const [viewRev, setViewRev] = useState<string | undefined>();
  const [docTabs, setDocTabs] = useState<DocTab[]>([]);
  const [activeDoc, setActiveDoc] = useState<string | null>(null);
  const [browser, setBrowser] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [picker, setPicker] = useState(false);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [activeNote, setActiveNote] = useState<string | null>(null);
  const [citedRevs, setCitedRevs] = useState(new Map<string, Set<string>>());
  const [dragging, setDragging] = useState(false);
  const [split, setSplit] = useState(0.5);
  const notes = useRef<NotesHandle>(null);
  const handles = useRef(new Map<string, ViewerHandle>());
  const statusCache = useRef(new Map<string, RefStatus>());
  const live = useRef({ settings, versions, docTabs, activeDoc, ws });
  live.current = { settings, versions, docTabs, activeDoc, ws };
  const terminology = settings?.terminology ?? 'simple';

  const showToast = useCallback((text: string) => setToast({ text, id: Date.now() }), []);

  // ---------- Settings and theme ----------

  useEffect(() => {
    api.getSettings().then(async (s) => {
      setSettings(s);
      setSplit(s.splitRatio);
      const last = s.recentWorkspaces[0];
      if (last) await openWorkspace(last).catch(() => undefined);
    });
  }, []);

  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const apply = () => {
      const dark = settings.dark === 'dark' || (settings.dark === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      root.dataset.theme = settings.theme;
      root.dataset.mode = dark ? 'dark' : 'light';
      const css = getComputedStyle(root);
      api.setTitleBarColors(css.getPropertyValue('--page').trim(), css.getPropertyValue('--text').trim()).catch(() => undefined);
    };
    apply();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings?.theme, settings?.dark]);

  const updateSettings = async (patch: Partial<Settings>) => setSettings(await api.setSettings(patch));

  // ---------- Workspace ----------

  const refreshVersions = useCallback(async () => {
    const v = await api.versions().catch(() => [] as Version[]);
    setVersions(v);
    setVersionsKey((k) => k + 1);
    statusCache.current.clear();
    notes.current?.refresh();
  }, []);

  async function openWorkspace(dir?: string, create = false) {
    const info = create ? await api.createWorkspace() : await api.openWorkspace(dir);
    if (!info) return;
    await notes.current?.saveAll();
    let s: Session = { notes: [], activeNote: null, docs: [], activeDoc: 0 };
    try {
      s = { ...s, ...JSON.parse(localStorage.getItem(sessionKey(info.root)) ?? '{}') };
    } catch {
      /* ignore */
    }
    const tabs: DocTab[] = s.docs.map((d) => ({ id: newId(), ...d, kind: fileKind(d.path) }));
    statusCache.current.clear();
    invalidateLatest();
    setViewRev(undefined);
    setNotice(null);
    setDocTabs(tabs);
    setActiveDoc(tabs[s.activeDoc]?.id ?? tabs[0]?.id ?? null);
    setSession(s);
    setWs(info);
    setSettings(await api.getSettings());
    const v = await api.versions().catch(() => [] as Version[]);
    setVersions(v);
  }

  const persistSession = (patch: Partial<Session>) => {
    const w = live.current.ws;
    if (!w) return;
    let s: Session = { notes: [], activeNote: null, docs: [], activeDoc: 0 };
    try {
      s = { ...s, ...JSON.parse(localStorage.getItem(sessionKey(w.root)) ?? '{}') };
    } catch {
      /* ignore */
    }
    localStorage.setItem(sessionKey(w.root), JSON.stringify({ ...s, ...patch }));
  };

  useEffect(() => {
    if (!ws) return;
    persistSession({
      docs: docTabs.map((t) => ({ path: t.path, external: t.external, rev: t.rev })),
      activeDoc: Math.max(0, docTabs.findIndex((t) => t.id === activeDoc)),
    });
  }, [docTabs, activeDoc, ws]);

  // Files may change outside the app: re-check when the window regains focus.
  useEffect(() => {
    const onFocus = () => {
      if (!live.current.ws) return;
      invalidateLatest();
      statusCache.current.clear();
      notes.current?.reloadFromDisk();
      notes.current?.refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // ---------- Documents ----------

  const openDoc = (path: string, external: boolean, rev?: string, loc?: Location) => {
    const tabs = live.current.docTabs;
    const existing = tabs.find((t) => t.path === path && t.external === external && sameRev(t.rev, rev));
    const reveal = loc ? revealOf(loc) : undefined;
    if (existing) {
      if (reveal) setDocTabs((ts) => ts.map((t) => (t.id === existing.id ? { ...t, reveal } : t)));
      setActiveDoc(existing.id);
      return;
    }
    const tab: DocTab = { id: newId(), path, external, rev, kind: fileKind(path), reveal };
    setDocTabs((ts) => [...ts, tab]);
    setActiveDoc(tab.id);
  };

  const closeDoc = (id: string) => {
    const tabs = live.current.docTabs;
    const i = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    setDocTabs(rest);
    if (live.current.activeDoc === id) setActiveDoc(rest[Math.min(i, rest.length - 1)]?.id ?? null);
    handles.current.delete(id);
  };

  const openFromBrowser = async (path: string, rev: string | undefined) => {
    setBrowser(false);
    if (fileKind(path) === 'markdown' && !rev) {
      await notes.current?.open(path);
      return;
    }
    openDoc(path, false, rev);
  };

  // ---------- References ----------

  const versionDate = (sha: string) => live.current.versions.find((v) => v.sha.startsWith(sha))?.date;

  const checkRef = async (info: LinkInfo, notePath: string): Promise<RefStatus> => {
    const ref = info.ref;
    const mode = live.current.settings?.terminology ?? 'simple';
    if (ref.pathKind === 'web' || (!ref.path && ref.pathKind === 'relative')) return { state: 'ok' };
    if (ref.pathKind === 'external') {
      const ok = await api.readExternal(ref.path).then(() => true, () => false);
      return ok ? { state: 'ok', badge: 'external' } : { state: 'broken', reason: `External file not found: ${ref.path}` };
    }
    const path = resolvePath(ref, notePath);
    if (ref.rev) {
      const badge = versionBadge(mode, ref.rev, versionDate(ref.rev));
      const ok = await api.exists(path, ref.rev).catch(() => false);
      return ok ? { state: 'ok', badge } : { state: 'broken', reason: `${basename(path)} isn't in that version`, badge };
    }
    if (await api.exists(path).catch(() => false)) return { state: 'ok' };
    const existed = ref.at ? await api.exists(path, ref.at).catch(() => false) : false;
    return {
      state: 'broken',
      reason: existed ? `${path.slice(1)} was moved or deleted since it was cited` : `File not found: ${path.slice(1)}`,
    };
  };

  const refStatus = (info: LinkInfo, notePath: string): RefStatus => {
    const key = `${notePath}|${info.dest}`;
    const cached = statusCache.current.get(key);
    if (cached) return cached;
    statusCache.current.set(key, { state: 'unknown' });
    checkRef(info, notePath).then((s) => {
      statusCache.current.set(key, s);
      if (s.state !== 'ok' || s.badge) notes.current?.refresh();
    });
    return { state: 'unknown' };
  };

  const followRef = async (info: LinkInfo, notePath: string) => {
    const ref = info.ref;
    setNotice(null);
    if (ref.pathKind === 'web') return;
    if (!ref.path) {
      if (ref.loc.heading) notes.current?.revealHeading(notePath, ref.loc.heading);
      return;
    }
    const external = ref.pathKind === 'external';
    const path = external ? ref.path : resolvePath(ref, notePath);
    const kind = fileKind(path);
    if (kind === 'markdown' && !ref.rev && !external) {
      await notes.current?.open(path);
      if (ref.loc.heading) setTimeout(() => notes.current?.revealHeading(path, ref.loc.heading!), 50);
      return;
    }
    let loc = ref.loc;
    let rev = ref.rev;
    if (!external && !rev) {
      if (!(await api.exists(path).catch(() => false))) {
        if (ref.at && (await api.exists(path, ref.at).catch(() => false))) {
          rev = ref.at;
          setNotice({ text: `${basename(path)} is no longer in the workspace. Showing the version it was cited from.` });
        } else {
          setNotice({ text: `${path.slice(1)} wasn't found.`, danger: true });
          return;
        }
      } else if (ref.at && loc.lines && kind === 'code') {
        const hunks = await api.diffHunks(path, ref.at).catch(() => []);
        const m = mapLines(hunks, loc.lines.start, loc.lines.end);
        loc = { ...loc, lines: { start: m.start, end: m.end } };
        const showCited = { label: 'Show the cited version', run: () => openDoc(path, false, ref.at, ref.loc) };
        if (m.status === 'changed') setNotice({ text: 'Some of these lines were edited since they were cited.', action: showCited });
        else if (m.status === 'gone') setNotice({ text: 'The cited lines were deleted since.', danger: true, action: showCited });
        else if (m.status === 'moved') showToast(`Lines moved to ${m.start}–${m.end} since this was cited`);
      }
    }
    openDoc(path, external, rev, loc);
  };

  const editorCallbacks = (notePath: string) => ({
    onFollow: (info: LinkInfo) => void followRef(info, notePath),
    refStatus: (info: LinkInfo) => refStatus(info, notePath),
    imageUrl: () => null,
    renderHoverCard: (info: LinkInfo, view: import('@codemirror/view').EditorView) =>
      renderHoverCard(info, view, {
        notePath,
        terminology: live.current.settings?.terminology ?? 'simple',
        status: refStatus(info, notePath),
        versionDate,
        follow: (i) => void followRef(i, notePath),
      }),
  });

  const recomputeCited = () => {
    const view = notes.current?.activeView();
    const notePath = notes.current?.activePath();
    const map = new Map<string, Set<string>>();
    if (view && notePath) {
      for (const l of allLinks(view.state)) {
        if (l.ref.pathKind !== 'root' && l.ref.pathKind !== 'relative') continue;
        const sha = l.ref.rev ?? l.ref.at;
        if (!sha) continue;
        const p = resolvePath(l.ref, notePath);
        if (!map.has(p)) map.set(p, new Set());
        map.get(p)!.add(sha);
      }
    }
    setCitedRevs(map);
  };

  const cite = async (tab?: DocTab) => {
    tab ??= live.current.docTabs.find((t) => t.id === live.current.activeDoc);
    if (!tab) return showToast('Open a document on the right first');
    const target = handles.current.get(tab.id)?.citeTarget();
    if (!target) return showToast('Nothing to cite yet');
    let view = notes.current?.activeView() ?? null;
    if (!view) view = (await notes.current?.newNote()) ?? null;
    if (!view) return;
    let ref: Reference;
    if (tab.external) {
      ref = { path: tab.path, pathKind: 'external', loc: target.loc, extra: [] };
    } else {
      let rev: string | undefined;
      let at: string | undefined;
      if (tab.rev) rev = shortSha(tab.rev);
      else {
        const sha = await api.ensureVersion(tab.path).catch(() => null);
        if (sha) at = shortSha(sha);
      }
      ref = { path: tab.path, pathKind: 'root', loc: target.loc, rev, at, extra: [] };
    }
    const label = defaultLabel(tab.path, target.loc, target.pageLabel);
    insertReference(view, (l) => formatReference(l, ref, target.quote), label);
    if (!tab.external && !tab.rev) void refreshVersions();
    setTimeout(recomputeCited, 0);
  };

  // ---------- Versions ----------

  const openSaveVersion = async () => {
    await notes.current?.saveAll();
    const changes = await api.uncommitted().catch(() => []);
    if (!changes.length) return showToast(term(terminology, 'nothingToSave'));
    const name = `${longDate(new Date().toISOString())} · ${changes.length} file${changes.length === 1 ? '' : 's'} changed`;
    setSaveName(name);
  };

  const doSaveVersion = async (name: string) => {
    setSaveName(null);
    const sha = await api.saveVersion(name);
    if (!sha) return showToast(term(terminology, 'nothingToSave'));
    await refreshVersions();
    showToast(terminology === 'git' ? `Committed ${sha.slice(0, 7)}` : 'Version saved');
  };

  // ---------- Keyboard ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!live.current.ws) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && e.shiftKey && k === 'l') {
        e.preventDefault();
        void cite();
      } else if (e.ctrlKey && !e.shiftKey && k === 'p') {
        e.preventDefault();
        setBrowser(true);
      } else if (e.ctrlKey && !e.shiftKey && k === 'n') {
        e.preventDefault();
        void notes.current?.newNote();
      } else if (e.ctrlKey && e.shiftKey && k === 's') {
        e.preventDefault();
        void openSaveVersion();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [terminology]);

  // Re-render badges when the terminology changes.
  useEffect(() => {
    statusCache.current.clear();
    notes.current?.refresh();
  }, [terminology]);

  // ---------- Render ----------

  if (!settings) return null;

  const viewing = viewRev ? versions.find((v) => v.sha === viewRev) : undefined;

  return (
    <div className="app">
      <div className="header">
        <span className="wordmark"><Logo /> Smart Doc Link</span>
        {ws && (
          <>
            <button className="no-drag ws-name" title={ws.root} onClick={() => void openWorkspace()}>
              <Icon name="folder" /> {ws.name}
            </button>
            <div style={{ position: 'relative' }} className="no-drag">
              <button className={'version-pill' + (viewRev ? ' old' : '')} onClick={() => setPicker(!picker)} title={term(terminology, 'history')}>
                <Icon name="history" />
                {viewing ? versionBadge(terminology, viewing.sha, viewing.date) : term(terminology, 'latest')}
                <Icon name="chevDown" size={14} />
              </button>
              {picker && (
                <VersionPicker
                  versions={versions}
                  current={viewRev}
                  terminology={terminology}
                  onPick={(sha) => {
                    setPicker(false);
                    setViewRev(sha);
                    if (sha) setBrowser(true);
                  }}
                  onClose={() => setPicker(false)}
                />
              )}
            </div>
            <div style={{ position: 'relative' }} className="no-drag">
              <button className="outline" onClick={() => void openSaveVersion()} title={`${term(terminology, 'saveVersionHint')} (Ctrl+Shift+S)`}>
                <Icon name="save" /> {term(terminology, 'saveVersion')}
              </button>
              {saveName !== null && <SaveVersionBox initial={saveName} terminology={terminology} onSave={doSaveVersion} onCancel={() => setSaveName(null)} />}
            </div>
            <div className="spacer" />
            <button className="quick-open" onClick={() => setBrowser(true)}>
              <span><Icon name="search" size={14} /> Go to file…</span>
              <span>Ctrl+P</span>
            </button>
          </>
        )}
        {!ws && <div className="spacer" />}
        <button className="icon" title="Settings" onClick={() => setShowSettings(true)}><Icon name="settings" /></button>
      </div>

      {viewRev && viewing && (
        <div className="notice">
          <Icon name="history" />
          {term(terminology, 'viewingOld')}: {terminology === 'git' ? viewing.sha.slice(0, 7) : longDate(viewing.date)} · {viewing.message}
          <button className="outline" onClick={() => setBrowser(true)}>Open a file from it</button>
          <button className="outline" onClick={() => setViewRev(undefined)}>Back to {term(terminology, 'latest').toLowerCase()}</button>
        </div>
      )}
      {notice && (
        <div className={'notice' + (notice.danger ? ' danger' : '')}>
          {notice.text}
          {notice.action && <button className="outline" onClick={() => { notice.action!.run(); setNotice(null); }}>{notice.action.label}</button>}
          <div className="spacer" />
          <button className="icon" onClick={() => setNotice(null)}><Icon name="x" /></button>
        </div>
      )}

      {!ws ? (
        <Welcome recent={settings.recentWorkspaces} onOpen={(d) => void openWorkspace(d)} onCreate={() => void openWorkspace(undefined, true)} />
      ) : (
        <div
          className="panes"
          onMouseMove={(e) => {
            if (!dragging) return;
            const r = e.currentTarget.getBoundingClientRect();
            setSplit(Math.min(0.8, Math.max(0.2, (e.clientX - r.left) / r.width)));
          }}
          onMouseUp={() => {
            if (!dragging) return;
            setDragging(false);
            void updateSettings({ splitRatio: split });
          }}
        >
          <div style={{ width: `${split * 100}%`, display: 'flex', minWidth: 0 }}>
            <NotesPane
              key={ws.root}
              ref={notes}
              initialPaths={session?.notes ?? []}
              initialActive={session?.activeNote ?? null}
              autosave={settings.autosave}
              callbacks={editorCallbacks}
              onSessionChange={(paths, active) => persistSession({ notes: paths, activeNote: active })}
              onActiveChange={(p) => {
                setActiveNote(p);
                setTimeout(recomputeCited, 0);
              }}
              toast={showToast}
            />
          </div>
          <div
            className={'divider' + (dragging ? ' dragging' : '')}
            onMouseDown={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDoubleClick={() => {
              setSplit(0.5);
              void updateSettings({ splitRatio: 0.5 });
            }}
          />
          <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>
            <DocsPane
              tabs={docTabs}
              activeId={activeDoc}
              terminology={terminology}
              versionsKey={versionsKey}
              citedRevs={citedRevs}
              onActivate={setActiveDoc}
              onClose={closeDoc}
              onOpen={() => setBrowser(true)}
              onCite={(t) => void cite(t)}
              onChangeRev={(tab, rev) => {
                if (sameRev(tab.rev, rev)) return;
                setDocTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, rev, reveal: undefined } : t)));
              }}
              registerHandle={(id, h) => {
                if (h) handles.current.set(id, h);
                else handles.current.delete(id);
              }}
            />
          </div>
        </div>
      )}

      {browser && ws && (
        <FileBrowser
          terminology={terminology}
          versions={versions}
          rev={viewRev}
          onRevChange={setViewRev}
          onOpen={(path, rev) => void openFromBrowser(path, rev)}
          onOpenExternal={(paths) => {
            setBrowser(false);
            for (const p of paths) openDoc(p, true);
          }}
          onClose={() => setBrowser(false)}
        />
      )}
      {showSettings && <SettingsDialog settings={settings} onChange={updateSettings} onClose={() => setShowSettings(false)} />}
      {toast && <div key={toast.id} className="toast">{toast.text}</div>}
    </div>
  );
}

function VersionPicker({
  versions,
  current,
  terminology,
  onPick,
  onClose,
}: {
  versions: Version[];
  current?: string;
  terminology: Settings['terminology'];
  onPick(sha: string | undefined): void;
  onClose(): void;
}) {
  useEffect(() => {
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest('.popover') && onClose();
    setTimeout(() => window.addEventListener('mousedown', close));
    return () => window.removeEventListener('mousedown', close);
  }, []);
  return (
    <div className="popover" style={{ top: 34, left: 0, width: 380, maxHeight: 420, overflow: 'auto' }}>
      <button className={'menu-item' + (!current ? ' selected' : '')} onClick={() => onPick(undefined)}>
        <Icon name="check" /> {term(terminology, 'latest')}
      </button>
      {versions.map((v) => (
        <button key={v.sha} className={'menu-item' + (current === v.sha ? ' selected' : '')} onClick={() => onPick(v.sha)}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {terminology === 'git' && <span className="mono" style={{ color: 'var(--muted)' }}>{v.sha.slice(0, 7)} </span>}
            {v.message}
          </span>
          <span className="sub">{v.auto && terminology === 'simple' ? 'auto · ' : ''}{longDate(v.date)}</span>
        </button>
      ))}
      {versions.length === 0 && <div className="muted" style={{ padding: 8 }}>No versions yet.</div>}
    </div>
  );
}

function SaveVersionBox({
  initial,
  terminology,
  onSave,
  onCancel,
}: {
  initial: string;
  terminology: Settings['terminology'];
  onSave(name: string): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(initial);
  return (
    <div className="popover" style={{ top: 34, left: 0, width: 360, padding: 12 }}>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>{term(terminology, 'versionName')}</div>
      <input
        autoFocus
        style={{ width: '100%' }}
        value={name}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave(name.trim() || initial);
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
        <button className="outline" onClick={onCancel}>Cancel</button>
        <button className="primary" onClick={() => onSave(name.trim() || initial)}>{term(terminology, 'saveVersion')}</button>
      </div>
    </div>
  );
}

function Welcome({ recent, onOpen, onCreate }: { recent: string[]; onOpen(dir?: string): void; onCreate(): void }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div>
          <h1>Welcome</h1>
          <p className="muted" style={{ marginTop: 0 }}>Pick a folder to work in. Your notes and the files they cite live there together.</p>
          <button className="choice" onClick={() => onOpen()}>
            <span><Icon name="folderOpen" /> <b>Open a folder</b></span>
            <span className="sub">Any folder of documents or code</span>
          </button>
          <button className="choice" onClick={onCreate}>
            <span><Icon name="folderPlus" /> <b>Create a new workspace</b></span>
            <span className="sub">Start empty and drop files in</span>
          </button>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Recent</div>
          {recent.length === 0 && <div className="muted">Nothing yet.</div>}
          {recent.map((r) => (
            <div key={r} className="recent-row" onClick={() => onOpen(r)}>
              <div style={{ fontWeight: 600 }}>{basename(r.replace(/\\/g, '/'))}</div>
              <div className="muted" style={{ fontSize: 12 }}>{r}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SettingsDialog({ settings, onChange, onClose }: { settings: Settings; onChange(p: Partial<Settings>): void; onClose(): void }) {
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 520 }}>
        <div className="dialog-head"><h2>Settings</h2></div>
        <div className="dialog-body" style={{ display: 'grid', gap: 18 }}>
          <section>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Terminology</div>
            <label style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
              <input type="radio" checked={settings.terminology === 'simple'} onChange={() => onChange({ terminology: 'simple' })} />
              <span><b>Simple</b> <span className="muted">· versions, sync, latest</span></span>
            </label>
            <label style={{ display: 'flex', gap: 8 }}>
              <input type="radio" checked={settings.terminology === 'git'} onChange={() => onChange({ terminology: 'git' })} />
              <span><b>Git</b> <span className="muted">· commits, pull and push, SHAs</span></span>
            </label>
          </section>
          <section>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Theme</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {THEMES.map((t) => (
                <button key={t.id} className={'outline' + (settings.theme === t.id ? ' active' : '')} style={settings.theme === t.id ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : undefined} onClick={() => onChange({ theme: t.id })}>
                  <span style={{ display: 'flex' }}>
                    {t.colors.map((c) => <span key={c} style={{ width: 10, height: 14, background: c }} />)}
                  </span>
                  {t.name}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
              <span className="muted">Appearance</span>
              <select value={settings.dark} onChange={(e) => onChange({ dark: e.target.value as Settings['dark'] })}>
                <option value="system">Match Windows</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
          </section>
          <section>
            <label style={{ display: 'flex', gap: 8 }}>
              <input type="checkbox" checked={settings.autosave} onChange={(e) => onChange({ autosave: e.target.checked })} />
              <span>Autosave notes <span className="muted">· saves a moment after you stop typing</span></span>
            </label>
          </section>
        </div>
        <div className="dialog-foot"><button className="primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
