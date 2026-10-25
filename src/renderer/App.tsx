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
import type { Citation, Settings, SharingInfo, SyncResult, Version, WorkspaceInfo } from '../shared/api';
import { ConflictDialog, GitHubOpenDialog, ShareDialog } from './ShareDialogs';
import { HistoryDialog } from './HistoryDialog';
import { movedPath } from '../core/rewrite';
import { api, shortSha } from './api';
import { DocsPane } from './docs/DocsPane';
import { FileBrowser } from './FileBrowser';
import { invalidateLatest, loadBytes, mimeFor } from './files';
import { locateQuote } from './viewers/pdf';
import { Icon, Logo } from './icons';
import { newId, revealOf, type DocTab } from './model';
import { allLinks, insertReference, setActiveLink, type LinkInfo, type RefStatus } from './notes/editor';
import { renderHoverCard } from './notes/hoverCard';
import { NotesPane, type NotesHandle } from './notes/NotesPane';
import { longDate, term, versionBadge } from './terms';
import type { ViewerHandle } from './viewers/types';
import type { CiteMode } from './viewers/CiteButton';
import { stepZoom } from './zoom';
import { ClaudeDialog, claudeNeedsSetup } from './ClaudeDialog';
import { isCanvas } from '../core/canvas';

interface Session {
  notes: string[];
  activeNote: string | null;
  docs: { path: string; external: boolean; rev?: string }[];
  activeDoc: number;
}

interface Notice {
  text: string;
  danger?: boolean;
  actions?: { label: string; run(): void }[];
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
  /** Version the file browser shows; set when browsing from History, reset otherwise. */
  const [browserRev, setBrowserRev] = useState<string | undefined>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [docTabs, setDocTabs] = useState<DocTab[]>([]);
  const [activeDoc, setActiveDoc] = useState<string | null>(null);
  const [browser, setBrowser] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** Kind of link Cite inserts while viewing the latest version (older versions are always pinned). */
  const [citeMode, setCiteMode] = useState<CiteMode>(() => {
    try {
      return localStorage.getItem('citeMode') === 'pinned' ? 'pinned' : 'live';
    } catch {
      return 'live';
    }
  });
  const [activeNote, setActiveNote] = useState<string | null>(null);
  const [citedRevs, setCitedRevs] = useState(new Map<string, Set<string>>());
  const [dragging, setDragging] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [isDark, setIsDark] = useState(false);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [tour, setTour] = useState<{ index: number; count: number; label: string } | null>(null);
  const [sharing, setSharing] = useState<SharingInfo | null>(null);
  const [unsharedEdits, setUnsharedEdits] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<number | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const [ghOpen, setGhOpen] = useState<{ repo?: string } | null>(null);
  const notes = useRef<NotesHandle>(null);
  const handles = useRef(new Map<string, ViewerHandle>());
  const statusCache = useRef(new Map<string, RefStatus>());
  const live = useRef({ settings, versions, docTabs, activeDoc, ws, tour, citeMode });
  live.current = { settings, versions, docTabs, activeDoc, ws, tour, citeMode };
  const terminology = settings?.terminology ?? 'simple';

  const showToast = useCallback((text: string) => setToast({ text, id: Date.now() }), []);
  /** The Claude setup dialog: 'first' when offered on its own, 'settings' when opened from Settings. */
  const [claudeDialog, setClaudeDialog] = useState<'first' | 'settings' | null>(null);

  // ---------- Settings and theme ----------

  useEffect(() => {
    api.getSettings().then(async (s) => {
      setSettings(s);
      setSplit(s.splitRatio);
      const last = s.recentWorkspaces[0];
      if (last) await openWorkspace(last).catch(() => undefined);
      void offerClaude(s);
    });
  }, []);

  // Offers Claude setup once per app version, and only when Claude is here and its tools are missing or old.
  const offerClaude = async (s: Settings) => {
    const version = await api.appVersion().catch(() => '');
    if (!version || s.claudeOffered === version || s.claudeOffered === 'skip') return;
    const status = await api.claudeStatus().catch(() => null);
    if (!status || !claudeNeedsSetup(status)) return;
    await api.setSettings({ claudeOffered: version });
    setClaudeDialog('first');
  };

  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const apply = () => {
      const dark = settings.dark === 'dark' || (settings.dark === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      root.dataset.theme = settings.theme;
      root.dataset.mode = dark ? 'dark' : 'light';
      setIsDark(dark);
      const css = getComputedStyle(root);
      api.setTitleBarColors(css.getPropertyValue('--page').trim(), css.getPropertyValue('--text').trim()).catch(() => undefined);
    };
    apply();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings?.theme, settings?.dark]);

  const updateSettings = async (patch: Partial<Settings>) => setSettings(await api.setSettings(patch));

  // ---------- Zoom (notes and documents separately) ----------

  /** The pane last clicked or typed in, so the zoom keys know which pane to zoom. */
  const lastPane = useRef<'notes' | 'docs'>('notes');
  const paneOf = (el: EventTarget | Element | null): 'notes' | 'docs' | null =>
    ((el instanceof Element ? el : null)?.closest('[data-pane]')?.getAttribute('data-pane') as 'notes' | 'docs' | null) ?? null;

  const setZoom = (key: 'noteZoom' | 'docZoom', z: number) => {
    setSettings((s) => (s ? { ...s, [key]: z } : s));
    void api.setSettings({ [key]: z }).catch(() => undefined);
  };

  const zoomPane = (pane: 'notes' | 'docs', dir: 1 | -1 | 0) => {
    const s = live.current.settings;
    if (!s) return;
    if (pane === 'notes') {
      // A flowchart zooms its own view.
      if (notes.current?.zoomFlow(dir)) return;
      return setZoom('noteZoom', stepZoom(s.noteZoom ?? 1, dir));
    }
    // A PDF zooms itself; every other viewer follows the documents zoom.
    const own = handles.current.get(live.current.activeDoc ?? '')?.zoom;
    if (own) own(dir);
    else setZoom('docZoom', stepZoom(s.docZoom ?? 1, dir));
  };

  useEffect(() => {
    const mark = (e: Event) => {
      const pane = paneOf(e.target);
      if (pane) lastPane.current = pane;
    };
    // Ctrl+wheel (and touchpad pinch) zooms the pane under the pointer, never the whole window.
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      // Flowcharts handle Ctrl+wheel (and pinch) themselves.
      if (!e.ctrlKey || (e.target instanceof Element && e.target.closest('.react-flow'))) return;
      e.preventDefault();
      const pane = paneOf(e.target);
      if (!pane) return;
      acc += e.deltaY;
      if (Math.abs(acc) < 40) return;
      zoomPane(pane, acc < 0 ? 1 : -1);
      acc = 0;
    };
    window.addEventListener('pointerdown', mark, true);
    window.addEventListener('focusin', mark, true);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('pointerdown', mark, true);
      window.removeEventListener('focusin', mark, true);
      window.removeEventListener('wheel', onWheel);
    };
  }, []);

  // ---------- Workspace ----------

  const refreshVersions = useCallback(async () => {
    const v = await api.versions().catch(() => [] as Version[]);
    setVersions(v);
    setVersionsKey((k) => k + 1);
    statusCache.current.clear();
    notes.current?.refresh();
  }, []);

  // ---------- Sharing ----------

  const refreshSharing = useCallback(async (doFetch: boolean) => {
    if (!live.current.ws) return;
    const info = await api.sharingStatus(doFetch).catch(() => null);
    setSharing(info);
    setUnsharedEdits((await api.uncommitted().catch(() => [])).length);
    if (info?.conflicts.length) setConflicts(info.conflicts);
  }, []);

  const afterSync = async (r: SyncResult) => {
    setConflicts(null);
    setLastSynced(Date.now());
    invalidateLatest();
    statusCache.current.clear();
    await notes.current?.reloadFromDisk();
    notes.current?.refresh();
    void refreshVersions();
    void loadCitations();
    void refreshSharing(false);
    const mode = live.current.settings?.terminology ?? 'simple';
    if (r.pulled && r.pushed) showToast(mode === 'git' ? `Pulled ${r.pulled}, pushed ${r.pushed}` : 'Synced: brought in updates and shared your changes');
    else if (r.pulled) showToast(mode === 'git' ? `Pulled ${r.pulled} commit${r.pulled === 1 ? '' : 's'}` : 'Synced: brought in updates');
    else if (r.pushed) showToast(mode === 'git' ? `Pushed ${r.pushed} commit${r.pushed === 1 ? '' : 's'}` : 'Synced: your changes are shared');
    else showToast('Already up to date');
  };

  const doSync = async () => {
    if (syncing) return;
    await notes.current?.saveAll();
    setSyncing(true);
    try {
      const r = await api.sync();
      if (r.conflicts.length) setConflicts(r.conflicts);
      else await afterSync(r);
    } catch (e) {
      showToast(String((e as Error).message).replace(/^Error invoking remote method 'api': (Error: )?/, ''));
      void refreshSharing(false);
    } finally {
      setSyncing(false);
    }
  };

  // Check the online copy every few minutes so "updates available" shows up on its own.
  useEffect(() => {
    if (!ws) return;
    const t = setInterval(() => void refreshSharing(true), 3 * 60 * 1000);
    return () => clearInterval(t);
  }, [ws]);

  // Double-clicked .locus files and locus://open?repo=owner/name links.
  useEffect(() => {
    const events = (window as unknown as { locusEvents?: { onOpenRequest(cb: (req: string) => void): void } }).locusEvents;
    events?.onOpenRequest(async (req) => {
      if (/^locus:/i.test(req)) {
        const repo = new URL(req).searchParams.get('repo') ?? undefined;
        setGhOpen({ repo });
      } else {
        const info = await api.importPackage(req).catch((e) => {
          showToast(String((e as Error).message).replace(/^Error invoking remote method 'api': (Error: )?/, ''));
          return null;
        });
        if (info) await openWorkspace(undefined, false, info);
      }
    });
  }, []);

  const loadCitations = useCallback(async () => {
    setCitations(await api.citations().catch(() => [] as Citation[]));
  }, []);

  async function openWorkspace(dir?: string, create = false, opened?: WorkspaceInfo) {
    const info = opened ?? (create ? await api.createWorkspace() : await api.openWorkspace(dir));
    if (!info) return;
    await notes.current?.saveAll();
    let s: Session = { notes: [], activeNote: null, docs: [], activeDoc: 0 };
    try {
      s = { ...s, ...JSON.parse(localStorage.getItem(sessionKey(info.root)) ?? '{}') };
    } catch {
      /* ignore */
    }
    // Drop tabs that can no longer open, e.g. a different repository now sits in this folder.
    const openable = await Promise.all(s.docs.map((d) => (d.external ? true : api.exists(d.path, d.rev).catch(() => false))));
    const restored = s.docs.filter((_, i) => openable[i]);
    const noteOk = await Promise.all(s.notes.map((n) => api.exists(n).catch(() => false)));
    s.notes = s.notes.filter((_, i) => noteOk[i]);
    if (s.activeNote && !s.notes.includes(s.activeNote)) s.activeNote = s.notes[0] ?? null;
    const activeDoc = restored.indexOf(s.docs[s.activeDoc]);
    const tabs: DocTab[] = restored.map((d) => ({ id: newId(), ...d, kind: fileKind(d.path) }));
    statusCache.current.clear();
    invalidateLatest();
    setBrowserRev(undefined);
    setNotice(null);
    setDocTabs(tabs);
    setActiveDoc(tabs[activeDoc]?.id ?? tabs[0]?.id ?? null);
    setSession(s);
    setWs(info);
    setSettings(await api.getSettings());
    const v = await api.versions().catch(() => [] as Version[]);
    setVersions(v);
    void loadCitations();
    setSharing(null);
    setLastSynced(null);
    void refreshSharing(true);
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
      void loadCitations();
      void checkMovedLinksRef.current();
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

  /** A note or flowchart picked in Open: edit it on the left or view it on the right. */
  const [openChoice, setOpenChoice] = useState<string | null>(null);
  const openBrowser = (rev?: string) => {
    setBrowserRev(rev);
    setBrowser(true);
  };

  const openFromBrowser = (path: string, rev: string | undefined) => {
    setBrowser(false);
    // A note or flowchart (latest version) can be edited on the left or viewed on the right; a
    // past version can only be viewed, and everything else opens in the viewer.
    if (!rev && (fileKind(path) === 'markdown' || isCanvas(path))) setOpenChoice(path);
    else openDoc(path, false, rev);
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
    if (await api.exists(path).catch(() => false)) return ref.at ? changeSinceCited(path, ref, info.title) : { state: 'ok' };
    const existed = ref.at ? await api.exists(path, ref.at).catch(() => false) : false;
    return {
      state: 'broken',
      reason: existed ? `${path.slice(1)} was moved or deleted since it was cited` : `File not found: ${path.slice(1)}`,
    };
  };

  /**
   * Whether what a live link points at changed since it was cited: cited code lines edited or
   * deleted, a quoted PDF passage moved or gone, or (other files) any change to the file.
   */
  const changeSinceCited = async (path: string, ref: Reference, quote?: string): Promise<RefStatus> => {
    const at = ref.at!;
    if (!(await api.fileChangedSince(path, at).catch(() => false))) return { state: 'ok' };
    const kind = fileKind(path);
    if ((kind === 'code' || kind === 'markdown') && ref.loc.lines) {
      const m = mapLines(await api.diffHunks(path, at).catch(() => []), ref.loc.lines.start, ref.loc.lines.end);
      if (m.status === 'same' || m.status === 'moved') return { state: 'ok' };
      return { state: 'ok', changed: true, reason: m.status === 'gone' ? 'The cited lines were deleted since' : 'The cited lines were edited since' };
    }
    if (kind === 'pdf' && quote && ref.loc.page) {
      const found = await loadBytes({ path, external: false })
        .then((data) => locateQuote(data, quote, ref.loc.page!))
        .catch(() => null);
      if (found?.page === ref.loc.page) return { state: 'ok' };
      return { state: 'ok', changed: true, reason: found ? `The quoted text moved to page ${found.page}` : 'The quoted text is no longer in the file' };
    }
    return { state: 'ok', changed: true, reason: `${basename(path)} changed since it was cited` };
  };

  const refStatus = (info: LinkInfo, notePath: string): RefStatus => {
    const key = `${notePath}|${info.dest}`;
    const cached = statusCache.current.get(key);
    if (cached) return cached;
    statusCache.current.set(key, { state: 'unknown' });
    checkRef(info, notePath).then((s) => {
      statusCache.current.set(key, s);
      if (s.state !== 'ok' || s.badge || s.changed) notes.current?.refresh();
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
    if ((kind === 'markdown' || isCanvas(path)) && !ref.rev && !external) {
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
      } else if (ref.at) {
        const at = ref.at;
        const date = versionDate(at);
        const since = date ? ` (cited ${longDate(date)})` : '';
        const actions = [
          { label: 'Compare', run: () => openCompare(path, at) },
          { label: 'Show the cited version', run: () => openDoc(path, false, at, ref.loc) },
        ];
        if (loc.lines && kind === 'code') {
          const hunks = await api.diffHunks(path, at).catch(() => []);
          const m = mapLines(hunks, loc.lines.start, loc.lines.end);
          loc = { ...loc, lines: { start: m.start, end: m.end } };
          if (m.status === 'changed') setNotice({ text: `Some of these lines were edited since they were cited${since}.`, actions });
          else if (m.status === 'gone') setNotice({ text: `The cited lines were deleted since${since}.`, danger: true, actions });
          else if (m.status === 'moved') showToast(`Lines moved to ${m.start}–${m.end} since this was cited`);
        } else if (await api.fileChangedSince(path, at).catch(() => false)) {
          const name = basename(path);
          if (kind === 'pdf' && info.title && loc.page) {
            // The quote says what was cited: find it in the latest file, even on another page.
            const found = await loadBytes({ path, external: false })
              .then((data) => locateQuote(data, info.title!, loc.page!))
              .catch(() => null);
            if (!found) setNotice({ text: `The quoted text is no longer in ${name}. It changed since you cited it${since}.`, danger: true, actions });
            else if (found.page !== loc.page) {
              loc = { ...loc, page: found.page, viewrect: loc.viewrect ? found.rect : undefined };
              setNotice({ text: `${name} changed since you cited it${since}. The quoted text is now on page ${found.page}.`, actions });
            }
          } else {
            setNotice({ text: `${name} changed since you cited it${since}. This shows the latest version.`, actions });
          }
        }
      }
    }
    openDoc(path, external, rev, loc);
  };

  const editorCallbacks = (notePath: () => string) => ({
    onFollow: (info: LinkInfo) => void followRef(info, notePath()),
    refStatus: (info: LinkInfo) => refStatus(info, notePath()),
    imageUrl: (info: LinkInfo) => imageUrl(info, notePath()),
    renderHoverCard: (info: LinkInfo, view: import('@codemirror/view').EditorView) =>
      renderHoverCard(info, view, {
        notePath: notePath(),
        terminology: live.current.settings?.terminology ?? 'simple',
        status: refStatus(info, notePath()),
        versionDate,
        follow: (i) => void followRef(i, notePath()),
        compare: (i) => {
          const left = i.ref.rev ?? i.ref.at;
          if (left) openCompare(resolvePath(i.ref, notePath()), left);
        },
      }),
  });

  // ---------- Images in notes ----------

  /** Object URLs for images shown in notes, loaded on first use (null while loading or missing). */
  const imageCache = useRef(new Map<string, string | null>());

  const imageUrl = (info: LinkInfo, notePath: string): string | null => {
    const ref = info.ref;
    if (ref.pathKind === 'web') return /^https:/i.test(info.dest) ? info.dest : null;
    const external = ref.pathKind === 'external';
    const path = external ? ref.path : resolvePath(ref, notePath);
    const key = `${path}@${ref.rev ?? ''}`;
    if (imageCache.current.has(key)) return imageCache.current.get(key)!;
    imageCache.current.set(key, null);
    loadBytes({ path, external, rev: ref.rev })
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeFor(path.split('.').pop()!.toLowerCase()) }));
        imageCache.current.set(key, url);
        notes.current?.refresh();
      })
      .catch(() => undefined);
    return null;
  };

  // ---------- Compare, citations, moved files ----------

  const openCompare = (path: string, left: string, right?: string) => {
    const tab: DocTab = { id: newId(), path, external: false, rev: right, kind: fileKind(path), compare: left };
    setDocTabs((ts) => [...ts, tab]);
    setActiveDoc(tab.id);
  };

  const openCitation = (c: { note: string; line: number }) => void notes.current?.revealLine(c.note, c.line);

  const movedFixes = useRef(new Map<string, string>());

  /** Finds live links in the active note whose file was moved outside the app, and offers to fix them. */
  const checkMovedLinks = async () => {
    const view = notes.current?.activeView();
    const notePath = notes.current?.activePath();
    if (!view || !notePath) return;
    const fixes = new Map<string, string>();
    for (const l of allLinks(view.state)) {
      const ref = l.ref;
      if (ref.rev || !ref.at || !ref.path || (ref.pathKind !== 'root' && ref.pathKind !== 'relative')) continue;
      const path = resolvePath(ref, notePath);
      if (await api.exists(path).catch(() => true)) continue;
      const to = await api.findMoved(path, ref.at).catch(() => null);
      if (to) fixes.set(l.dest, to);
    }
    movedFixes.current = fixes;
    if (!fixes.size) return;
    const n = allLinks(view.state).filter((l) => fixes.has(l.dest)).length;
    setNotice({
      text: `${n} link${n === 1 ? ' points' : 's point'} to ${fixes.size === 1 ? 'a file that was' : 'files that were'} moved.`,
      actions: [{ label: 'Fix links', run: () => applyMovedFixes() }],
    });
  };
  const checkMovedLinksRef = useRef(checkMovedLinks);
  checkMovedLinksRef.current = checkMovedLinks;

  const applyMovedFixes = () => {
    const view = notes.current?.activeView();
    if (!view) return;
    const changes = allLinks(view.state)
      .filter((l) => movedFixes.current.has(l.dest))
      .map((l) => ({
        from: l.from,
        to: l.to,
        insert: formatReference(l.label, { ...l.ref, path: movedFixes.current.get(l.dest)!, pathKind: 'root' }, l.title),
      }));
    view.dispatch({ changes });
    statusCache.current.clear();
    notes.current?.refresh();
    showToast(`Fixed ${changes.length} link${changes.length === 1 ? '' : 's'}`);
  };

  const renameFile = async (from: string, to: string) => {
    await notes.current?.saveAll();
    try {
      const r = await api.renameFile(from, to);
      notes.current?.handleMove(from, to);
      setDocTabs((ts) =>
        ts.map((t) => {
          const moved = !t.external && !t.rev ? movedPath(t.path, [{ from, to }]) : null;
          return moved ? { ...t, path: moved, kind: fileKind(moved) } : t;
        }),
      );
      invalidateLatest();
      statusCache.current.clear();
      await notes.current?.reloadFromDisk();
      notes.current?.refresh();
      void loadCitations();
      const n = r.updatedNotes.length;
      showToast(r.links ? `Moved. Updated ${r.links} link${r.links === 1 ? '' : 's'} in ${n} note${n === 1 ? '' : 's'}` : 'Moved');
    } catch (e) {
      showToast(String((e as Error).message).replace(/^Error invoking remote method 'api': Error: /, ''));
    }
  };

  // ---------- Tour mode ----------

  const tourLinks = () => {
    const view = notes.current?.activeView();
    return view ? allLinks(view.state).filter((l) => !l.image && l.ref.pathKind !== 'web') : [];
  };

  const tourGo = (i: number) => {
    const view = notes.current?.activeView();
    const notePath = notes.current?.activePath();
    if (!view || !notePath) return;
    const links = tourLinks();
    if (!links.length) {
      showToast('This note has no references to tour');
      return;
    }
    const idx = Math.max(0, Math.min(i, links.length - 1));
    const l = links[idx];
    setActiveLink(view, l.from);
    setTour({ index: idx, count: links.length, label: l.label });
    void followRef(l, notePath);
  };

  const tourStop = () => {
    const view = notes.current?.activeView();
    if (view) setActiveLink(view, null);
    setTour(null);
  };

  const toggleTour = () => {
    if (live.current.tour) return tourStop();
    (document.activeElement as HTMLElement | null)?.blur?.();
    tourGo(0);
  };

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
    // A flowchart takes the citation into a box; otherwise it goes into the active note.
    const flow = notes.current?.activeFlow() ?? null;
    let view = flow ? null : (notes.current?.activeView() ?? null);
    if (!flow && !view) view = (await notes.current?.newNote()) ?? null;
    if (!flow && !view) return;
    let ref: Reference;
    if (tab.external) {
      ref = { path: tab.path, pathKind: 'external', loc: target.loc, extra: [] };
    } else {
      let rev: string | undefined;
      let at: string | undefined;
      if (tab.rev) rev = shortSha(tab.rev);
      else {
        // Citing the latest version: a live link remembers it, a pinned link points at it.
        const sha = await api.ensureVersion(tab.path).catch(() => null);
        if (sha && live.current.citeMode === 'pinned') rev = shortSha(sha);
        else if (sha) at = shortSha(sha);
      }
      ref = { path: tab.path, pathKind: 'root', loc: target.loc, rev, at, extra: [] };
    }
    const label = defaultLabel(tab.path, target.loc, target.pageLabel);
    if (flow) flow.insertCitation((l) => formatReference(l, ref, target.quote), label);
    else insertReference(view!, (l) => formatReference(l, ref, target.quote), label);
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
    void refreshSharing(false);
    showToast(terminology === 'git' ? `Committed ${sha.slice(0, 7)}` : 'Version saved');
  };

  // ---------- Keyboard ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!live.current.ws) return;
      const k = e.key.toLowerCase();
      const zoomIn = e.key === '=' || e.key === '+' || e.code === 'NumpadAdd';
      const zoomOut = e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract';
      if (e.ctrlKey && !e.altKey && (zoomIn || zoomOut)) {
        // Zoom the pane being worked in (Ctrl+0 stays "normal text" in notes; click the % to reset).
        e.preventDefault();
        zoomPane(paneOf(document.activeElement) ?? lastPane.current, zoomIn ? 1 : -1);
      } else if (e.ctrlKey && e.shiftKey && k === 'l') {
        e.preventDefault();
        void cite();
      } else if (e.ctrlKey && !e.shiftKey && k === 'p') {
        e.preventDefault();
        openBrowser();
      } else if (e.ctrlKey && !e.shiftKey && k === 'o') {
        e.preventDefault();
        openBrowser();
      } else if (e.ctrlKey && !e.shiftKey && k === 'n') {
        e.preventDefault();
        void notes.current?.newNote();
      } else if (e.ctrlKey && e.shiftKey && k === 's') {
        e.preventDefault();
        void openSaveVersion();
      } else if (e.ctrlKey && e.shiftKey && k === 't') {
        e.preventDefault();
        toggleTour();
      } else if (live.current.tour) {
        const t = e.target as HTMLElement;
        const typing = t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
        const cur = live.current.tour.index;
        if (e.key === 'PageDown' || (!typing && e.key === 'ArrowRight')) {
          e.preventDefault();
          tourGo(cur + 1);
        } else if (e.key === 'PageUp' || (!typing && e.key === 'ArrowLeft')) {
          e.preventDefault();
          tourGo(cur - 1);
        } else if (e.key === 'Escape' && !typing) {
          tourStop();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [terminology]);

  // Version dates arrive after notes may have drawn their badges; redraw them once known.
  useEffect(() => {
    statusCache.current.clear();
    notes.current?.refresh();
  }, [versions]);

  // Re-render badges when the terminology changes.
  useEffect(() => {
    statusCache.current.clear();
    notes.current?.refresh();
  }, [terminology]);

  // ---------- Render ----------

  if (!settings) return null;

  return (
    <div className="app">
      <div className="header">
        <span className="wordmark"><Logo /> Locus</span>
        {ws && (
          <>
            <button className="no-drag ws-name" title={ws.root} onClick={() => void openWorkspace()}>
              <Icon name="folder" /> {ws.name}
            </button>
            <button className="outline" onClick={() => openBrowser()} title="Open a document as it is now, or from any past version (Ctrl+P)">
              <Icon name="folderOpen" /> Open
            </button>
            <div style={{ position: 'relative' }} className="no-drag">
              <button className="outline" onClick={() => void openSaveVersion()} title={`${term(terminology, 'saveVersionHint')} (Ctrl+Shift+S)`}>
                <Icon name="save" /> {term(terminology, 'saveVersion')}
              </button>
              {saveName !== null && <SaveVersionBox initial={saveName} terminology={terminology} onSave={doSaveVersion} onCancel={() => setSaveName(null)} />}
            </div>
            <SyncPill
              sharing={sharing}
              unshared={unsharedEdits}
              syncing={syncing}
              lastSynced={lastSynced}
              terminology={terminology}
              onSync={() => (conflicts ? setConflicts([...conflicts]) : void doSync())}
            />
            <button className="outline" onClick={() => setShareOpen(true)}>
              <Icon name="share" /> {term(terminology, 'share')}
            </button>
          </>
        )}
        <div className="spacer" />
        <button
          className="icon"
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => void updateSettings({ dark: isDark ? 'light' : 'dark' })}
        >
          <Icon name={isDark ? 'sun' : 'moon'} />
        </button>
        <button className="icon" title="Settings" onClick={() => setShowSettings(true)}><Icon name="settings" /></button>
      </div>

      {notice && (
        <div className={'notice' + (notice.danger ? ' danger' : '')}>
          {notice.text}
          {notice.actions?.map((a) => (
            <button key={a.label} className="outline" onClick={() => { a.run(); setNotice(null); }}>{a.label}</button>
          ))}
          <div className="spacer" />
          <button className="icon" onClick={() => setNotice(null)}><Icon name="x" /></button>
        </div>
      )}

      {tour && (
        <div className="tour-bar">
          <Icon name="presentation" /> Tour · stop {tour.index + 1} of {tour.count}
          <span className="label">{tour.label}</span>
          <div className="spacer" />
          <span style={{ opacity: 0.8, fontSize: 12 }}>← → to move · Esc to end</span>
          <button onClick={() => tourGo(tour.index - 1)} disabled={tour.index === 0}><Icon name="chevLeft" /> Previous</button>
          <button onClick={() => tourGo(tour.index + 1)} disabled={tour.index >= tour.count - 1}>Next <Icon name="chevRight" /></button>
          <button onClick={tourStop}><Icon name="x" /> End</button>
        </div>
      )}

      {!ws ? (
        <Welcome
          recent={settings.recentWorkspaces}
          terminology={terminology}
          onOpen={(d) => void openWorkspace(d)}
          onCreate={() => void openWorkspace(undefined, true)}
          onImport={async () => {
            try {
              const info = await api.importPackage();
              if (info) await openWorkspace(undefined, false, info);
            } catch (e) {
              showToast(String((e as Error).message).replace(/^Error invoking remote method 'api': (Error: )?/, ''));
            }
          }}
          onGitHub={() => setGhOpen({})}
        />
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
          <div data-pane="notes" style={{ width: `${split * 100}%`, display: 'flex', minWidth: 0 }}>
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
                if (live.current.tour) tourStop();
                setTimeout(recomputeCited, 0);
                setTimeout(() => void checkMovedLinks(), 300);
              }}
              toast={showToast}
              onTour={toggleTour}
              touring={!!tour}
              zoom={settings.noteZoom ?? 1}
              onZoom={(z) => setZoom('noteZoom', z)}
              onSaved={() => {
                void loadCitations();
                void refreshSharing(false);
              }}
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
          <div data-pane="docs" style={{ flex: 1, display: 'flex', minWidth: 0 }}>
            <DocsPane
              docZoom={settings.docZoom ?? 1}
              onDocZoom={(z) => setZoom('docZoom', z)}
              tabs={docTabs}
              activeId={activeDoc}
              terminology={terminology}
              versionsKey={versionsKey}
              citedRevs={citedRevs}
              citations={citations}
              onCompare={(tab, rev) => setDocTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, compare: rev } : t)))}
              onOpenCitation={openCitation}
              onActivate={setActiveDoc}
              onClose={closeDoc}
              onCite={(t) => void cite(t)}
              noteCallbacks={(path) => editorCallbacks(() => path)}
              onEditInNotes={(path) => void notes.current?.open(path)}
              citeMode={citeMode}
              onCiteMode={(m) => {
                setCiteMode(m);
                try {
                  localStorage.setItem('citeMode', m);
                } catch {
                  /* ignore */
                }
              }}
              onChangeRev={(tab, rev) => {
                if (sameRev(tab.rev, rev)) return;
                setDocTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, rev, reveal: undefined } : t)));
              }}
              versionDate={versionDate}
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
          rev={browserRev}
          onRevChange={setBrowserRev}
          onOpen={(path, rev) => void openFromBrowser(path, rev)}
          onOpenExternal={(paths) => {
            setBrowser(false);
            for (const p of paths) openDoc(p, true);
          }}
          onClose={() => setBrowser(false)}
          onHistory={() => {
            setBrowser(false);
            setHistoryOpen(true);
          }}
          onRename={renameFile}
        />
      )}
      {openChoice && (
        <OpenChoiceDialog
          path={openChoice}
          onEdit={() => {
            setOpenChoice(null);
            void notes.current?.open(openChoice);
          }}
          onView={() => {
            setOpenChoice(null);
            openDoc(openChoice, false);
          }}
          onClose={() => setOpenChoice(null)}
        />
      )}
      {historyOpen && ws && (
        <HistoryDialog
          versions={versions}
          terminology={terminology}
          initialSelected={browserRev}
          onClose={() => setHistoryOpen(false)}
          onBack={() => {
            setHistoryOpen(false);
            openBrowser(browserRev);
          }}
          onOpenFile={(path, sha) => {
            setHistoryOpen(false);
            openDoc(path, false, sha);
          }}
          onBrowse={(sha) => {
            setHistoryOpen(false);
            openBrowser(sha);
          }}
        />
      )}
      {shareOpen && ws && (
        <ShareDialog
          ws={ws}
          terminology={terminology}
          toast={showToast}
          onShared={() => void refreshSharing(false)}
          onClose={() => {
            setShareOpen(false);
            void refreshSharing(false);
          }}
        />
      )}
      {conflicts && conflicts.length > 0 && (
        <ConflictDialog
          files={conflicts}
          terminology={terminology}
          onResolved={(r) => void afterSync(r)}
          onCancel={async () => {
            await api.abortSync().catch(() => undefined);
            setConflicts(null);
            await notes.current?.reloadFromDisk();
            void refreshSharing(false);
          }}
        />
      )}
      {ghOpen && (
        <GitHubOpenDialog
          initialRepo={ghOpen.repo}
          onClose={() => setGhOpen(null)}
          onOpened={(info) => {
            setGhOpen(null);
            void openWorkspace(undefined, false, info);
          }}
        />
      )}
      {showSettings && (
        <SettingsDialog
          settings={settings}
          onChange={updateSettings}
          onClose={() => setShowSettings(false)}
          onClaude={() => {
            setShowSettings(false);
            setClaudeDialog('settings');
          }}
        />
      )}
      {claudeDialog && <ClaudeDialog first={claudeDialog === 'first'} onClose={() => setClaudeDialog(null)} />}
      {toast && <div key={toast.id} className="toast">{toast.text}</div>}
    </div>
  );
}

function SyncPill({
  sharing,
  unshared,
  syncing,
  lastSynced,
  terminology,
  onSync,
}: {
  sharing: SharingInfo | null;
  unshared: number;
  syncing: boolean;
  lastSynced: number | null;
  terminology: Settings['terminology'];
  onSync(): void;
}) {
  if (!sharing?.remote) return null;
  const git = terminology === 'git';
  const toShare = sharing.ahead + (unshared > 0 ? 1 : 0);
  let cls = 'ok';
  let label: string;
  let icon: 'sync' | 'cloud' = 'cloud';
  if (syncing) {
    label = git ? 'Pulling and pushing…' : 'Syncing…';
    cls = 'pending spinning';
    icon = 'sync';
  } else if (sharing.conflicts.length) {
    label = 'Resolve conflicts';
    cls = 'warn';
  } else if (sharing.error) {
    label = git ? 'Remote unreachable' : 'Offline';
    cls = 'warn';
  } else if (sharing.behind > 0 || toShare > 0) {
    cls = 'pending';
    icon = 'sync';
    if (git) label = `↓${sharing.behind} ↑${sharing.ahead}${unshared ? ` · ${unshared} uncommitted` : ''}`;
    else if (sharing.behind > 0 && toShare > 0) label = 'Updates available · changes to share';
    else if (sharing.behind > 0) label = 'Updates available';
    else label = 'Changes to share';
  } else {
    const ago = lastSynced ? Math.round((Date.now() - lastSynced) / 60000) : null;
    label = git ? 'Up to date' : ago === null ? 'Synced' : ago < 1 ? 'Synced just now' : `Synced ${ago} min ago`;
  }
  return (
    <button className={'sync-pill ' + cls} title={git ? 'Pull and push (Sync)' : 'Sync with the online copy'} onClick={onSync}>
      <Icon name={icon} /> {label}
    </button>
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

function Welcome({
  recent,
  terminology,
  onOpen,
  onCreate,
  onImport,
  onGitHub,
}: {
  recent: string[];
  terminology: Settings['terminology'];
  onOpen(dir?: string): void;
  onCreate(): void;
  onImport(): void;
  onGitHub(): void;
}) {
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
          <button className="choice" onClick={onImport}>
            <span><Icon name="package" /> <b>{term(terminology, 'openPackage')}</b></span>
            <span className="sub">A .locus file someone sent you</span>
          </button>
          <button className="choice" onClick={onGitHub}>
            <span><Icon name="github" /> <b>{term(terminology, 'downloadGitHub')}</b></span>
            <span className="sub">A workspace someone shared with you online</span>
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

/** Notes and flowcharts picked in Open: edit on the left, or view (read-only) on the right. */
function OpenChoiceDialog({ path, onEdit, onView, onClose }: { path: string; onEdit(): void; onView(): void; onClose(): void }) {
  const flow = isCanvas(path);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'Enter' || e.key.toLowerCase() === 'e') (e.preventDefault(), onEdit());
      else if (e.key.toLowerCase() === 'v') (e.preventDefault(), onView());
    };
    // Start listening after this turn: the Enter that picked the file is still on its way up.
    const t = setTimeout(() => window.addEventListener('keydown', onKey));
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="locus-dialog open-choice" style={{ width: 460 }}>
        <div className="dialog-head">
          <h2>
            <Icon name={flow ? 'flow' : 'note'} /> {basename(path)}
          </h2>
        </div>
        <div className="dialog-body open-choice-body">
          <button className="open-choice-option primary-choice" onClick={onEdit}>
            <span className="title"><Icon name="edit" /> Edit</span>
            <span className="muted">Opens on the left, where you write and cite. <kbd>E</kbd></span>
          </button>
          <button className="open-choice-option" onClick={onView}>
            <span className="title"><Icon name="file" /> View</span>
            <span className="muted">Opens read-only on the right, beside your notes. <kbd>V</kbd></span>
          </button>
        </div>
        <div className="dialog-foot">
          <div className="spacer" />
          <button className="outline" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function SettingsDialog({
  settings,
  onChange,
  onClose,
  onClaude,
}: {
  settings: Settings;
  onChange(p: Partial<Settings>): void;
  onClose(): void;
  onClaude(): void;
}) {
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="locus-dialog" style={{ width: 520 }}>
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
            <div className="segmented" role="radiogroup" aria-label="Light or dark">
              {(
                [
                  ['light', 'Light', 'sun'],
                  ['dark', 'Dark', 'moon'],
                  ['system', 'Match Windows', 'monitor'],
                ] as const
              ).map(([value, label, icon]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={settings.dark === value}
                  className={settings.dark === value ? 'on' : ''}
                  onClick={() => onChange({ dark: value })}
                >
                  <Icon name={icon} /> {label}
                </button>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12.5, margin: '10px 0 6px' }}>Colours (each has a light and a dark version)</div>
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
          </section>
          <section>
            <label style={{ display: 'flex', gap: 8 }}>
              <input type="checkbox" checked={settings.autosave} onChange={(e) => onChange({ autosave: e.target.checked })} />
              <span>Autosave notes <span className="muted">· saves a moment after you stop typing</span></span>
            </label>
          </section>
          <section>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Claude</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="muted" style={{ flex: 1 }}>Let Claude Code or Claude Desktop write notes, tours and flowcharts in your workspaces.</span>
              <button className="outline" onClick={onClaude}>Set up Claude…</button>
            </div>
          </section>
        </div>
        <div className="dialog-foot"><button className="primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
