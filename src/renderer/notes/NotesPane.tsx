import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { basename, dirname, formatReference, slugify, stem } from '../../core/link';
import { api } from '../api';
import { decodeText } from '../files';
import { Icon, type IconName } from '../icons';
import { newId, type NoteTab } from '../model';
import {
  createNoteEditor,
  docText,
  editorRedo,
  editorUndo,
  flashLine,
  flashRange,
  formatState,
  insertBlock,
  insertLink,
  refreshEffect,
  setHeading,
  toggleLinePrefix,
  toggleWrap,
  NO_FORMAT,
  type FormatState,
  type NoteEditorOptions,
} from './editor';
import { insertTable } from './tables';
import { setEditorZoom, ZoomControl } from '../zoom';
import { isCanvas, newCanvas, serializeCanvas } from '../../core/canvas';
import { joinNoteId, splitNoteId } from '../../core/noteid';
import { FlowEditor, type FlowHandle } from '../flow/FlowEditor';
import { ConfirmDialog, ContextMenu, PathDialog, type ConfirmRequest, type MenuItem, type MenuState, type PathRequest } from '../menus';

export interface NotesHandle {
  activeView(): EditorView | null;
  /** The flowchart in the active tab, if it is one. */
  activeFlow(): FlowHandle | null;
  /** Zooms the active flowchart's view; false when the active tab isn't a flowchart. */
  zoomFlow(dir: 1 | -1 | 0): boolean;
  activePath(): string | null;
  /** The active note as it is on screen, unsaved changes included. */
  activeText(): string;
  open(path: string): Promise<EditorView | null>;
  newNote(): Promise<EditorView | null>;
  newFlowchart(): Promise<void>;
  saveAll(): Promise<void>;
  /** Re-render references (after link checks or version changes). */
  refresh(): void;
  revealHeading(path: string, slug: string): void;
  reloadFromDisk(): Promise<void>;
  /** Follows a file or folder move for open notes. */
  handleMove(from: string, to: string): void;
  /** Opens a note and flashes a line ("Cited in" jumps). */
  revealLine(path: string, line: number): Promise<void>;
}

type EditorCallbacks = Pick<NoteEditorOptions, 'onFollow' | 'refStatus' | 'imageUrl' | 'renderHoverCard'>;

interface Props {
  initialPaths: string[];
  initialActive: string | null;
  autosave: boolean;
  /** Most tabs open at once (0 = no limit). */
  tabLimit: number;
  /** Editor callbacks for a note; `notePath` returns its current path (it can be moved). */
  callbacks(notePath: () => string): EditorCallbacks;
  onSessionChange(paths: string[], active: string | null): void;
  onActiveChange(path: string | null): void;
  toast(msg: string): void;
  onTour(): void;
  touring: boolean;
  /** Opens the section-link dialog (the bookmark button, Ctrl+Alt+L). */
  onLinkSection(): void;
  /** Zoom of the notes editor, separate from the documents'. */
  zoom: number;
  onZoom(z: number): void;
  /** Called after a note is written to disk. */
  onSaved(path: string): void;
  /** Moves a file and rewrites the links to it. */
  onRename(from: string, to: string): Promise<void>;
  /** Called after a note or flowchart was deleted. */
  onDeleted(path: string): void;
  /** How many links in other notes point at this file. */
  linksTo(path: string): number;
  /** Exports a note as a web page or a PDF; `text` is what the tab shows now. */
  onExport(path: string, text: string, kind: 'html' | 'pdf' | 'folder'): void;
}

/** An open flowchart (.canvas file); its editor reports changes as file text. */
interface Flow {
  path: string;
  initialText: string;
  savedText: string;
  text: string;
  handle: FlowHandle | null;
  timer?: number;
}

interface Doc {
  /** Current path; updated when the note is moved, so callbacks always save to the right file. */
  path: string;
  view: EditorView;
  bom: boolean;
  savedText: string;
  /** The note's hidden identity (the last line of the file), kept out of the editor. */
  noteId?: string;
  timer?: number;
}

export const NotesPane = forwardRef<NotesHandle, Props>(function NotesPane(p, ref) {
  const [tabs, setTabs] = useState<NoteTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const docs = useRef(new Map<string, Doc>());
  const flows = useRef(new Map<string, Flow>());
  const [flowZoom, setFlowZoom] = useState(1);
  const hosts = useRef(new Map<string, HTMLDivElement>());
  const pending = useRef(new Map<string, Promise<EditorView | null>>());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(active);
  activeRef.current = active;
  const autosaveRef = useRef(p.autosave);
  autosaveRef.current = p.autosave;

  /** What applies at the cursor of the note in front, for the toolbar. */
  const [fmt, setFmt] = useState<FormatState>(NO_FORMAT);
  const showFormat = (v: EditorView | null | undefined) => {
    const next = v ? formatState(v.state) : NO_FORMAT;
    setFmt((old) => ((Object.keys(next) as (keyof FormatState)[]).every((k) => old[k] === next[k]) ? old : next));
  };

  const setDirty = (path: string, dirty: boolean) =>
    setTabs((ts) => ts.map((t) => (t.path === path && t.dirty !== dirty ? { ...t, dirty } : t)));

  const save = async (path: string, announce = false) => {
    const fl = flows.current.get(path);
    if (fl) {
      clearTimeout(fl.timer);
      const text = fl.handle?.text() ?? fl.text;
      if (text !== fl.savedText) {
        await api.writeText(path, text);
        fl.savedText = text;
        p.onSaved(path);
      }
      setDirty(path, false);
      if (announce) p.toast(`Saved ${basename(path)}`);
      return;
    }
    const d = docs.current.get(path);
    if (!d) return;
    clearTimeout(d.timer);
    const text = docText(d.view);
    if (text !== d.savedText) {
      // Something may have linked to this note since it was opened, giving it an identity.
      d.noteId ??= await api
        .readText(path)
        .then((t) => splitNoteId(t).id)
        .catch(() => undefined);
      await api.writeText(path, (d.bom ? '﻿' : '') + joinNoteId(text, d.noteId, text.includes('\r\n') ? '\r\n' : '\n'));
      d.savedText = text;
      p.onSaved(path);
    }
    setDirty(path, false);
    if (announce) p.toast(`Saved ${basename(path)}`);
  };

  /** Saves a pasted or dropped picture as a new file under /images/<note name>/. */
  const saveImage = async (notePath: string, file: File): Promise<string | null> => {
    const ext = ({ 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' } as Record<string, string>)[file.type] ?? 'png';
    const now = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    // A screenshot or copied picture arrives as "image.png"; a dropped file keeps its own name.
    const given = file.name && !/^image\.\w+$/i.test(file.name) ? file.name.replace(/[<>:"/\\|?*]/g, '') : '';
    const base = given ? stem(given) : `pasted-${stamp}`;
    const dir = `/images/${stem(notePath)}`;
    try {
      let path = `${dir}/${base}.${ext}`;
      for (let n = 2; await api.exists(path); n++) path = `${dir}/${base}-${n}.${ext}`;
      await api.writeNewFile(path, new Uint8Array(await file.arrayBuffer()));
      return path;
    } catch {
      p.toast("Couldn't save the picture");
      return null;
    }
  };

  const openFlow = async (path: string) => {
    if (!flows.current.has(path)) {
      let text: string;
      try {
        text = decodeText(await api.readFile(path)).text;
      } catch {
        p.toast(`Couldn't open ${basename(path)}`);
        return;
      }
      flows.current.set(path, { path, initialText: text, savedText: text, text, handle: null });
    }
    setTabs((ts) => (ts.some((t) => t.path === path) ? ts : [...ts, { id: newId(), path, dirty: false }]));
    setActive(path);
    // Wait for the editor to mount, so callers can cite into it straight away.
    for (let i = 0; !flows.current.get(path)?.handle && i < 120; i++) await new Promise((r) => requestAnimationFrame(r));
  };

  const open = (path: string): Promise<EditorView | null> => {
    if (isCanvas(path)) return openFlow(path).then(() => null);
    const existing = docs.current.get(path);
    if (existing) {
      setActive(path);
      return Promise.resolve(existing.view);
    }
    if (pending.current.has(path)) return pending.current.get(path)!;
    const promise = (async () => {
      let bytes: Uint8Array;
      try {
        bytes = await api.readFile(path);
      } catch {
        p.toast(`Couldn't open ${basename(path)}`);
        return null;
      }
      const { text: fileText, bom, eol } = decodeText(bytes);
      const { body: text, id: noteId } = splitNoteId(fileText);
      setTabs((ts) => (ts.some((t) => t.path === path) ? ts : [...ts, { id: newId(), path, dirty: false }]));
      setActive(path);
      // Wait for React to mount the tab's host div (can take more than one frame).
      let host = hosts.current.get(path);
      for (let i = 0; !host && i < 120; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        host = hosts.current.get(path);
      }
      if (!host) {
        p.toast(`Couldn't open ${basename(path)}`);
        return null;
      }
      const doc = { path, bom, savedText: text, noteId } as Doc;
      const cb = p.callbacks(() => doc.path);
      doc.view = createNoteEditor(host, {
        doc: text,
        eol,
        zoom: zoomRef.current,
        ...cb,
        onSave: () => void save(doc.path, true),
        saveImage: (file) => saveImage(doc.path, file),
        onCursor: () => doc.path === activeRef.current && showFormat(doc.view),
        onChange: () => {
          setDirty(doc.path, docText(doc.view) !== doc.savedText);
          clearTimeout(doc.timer);
          if (autosaveRef.current) doc.timer = window.setTimeout(() => void save(doc.path), 900);
        },
      });
      const view = doc.view;
      docs.current.set(path, doc);
      return view;
    })();
    pending.current.set(path, promise);
    promise.finally(() => pending.current.delete(path));
    return promise;
  };

  /** Closes a tab, saving it first unless `discard` is set. */
  const close = async (path: string, discard = false) => {
    const fl = flows.current.get(path);
    if (fl) {
      if (discard) clearTimeout(fl.timer);
      else await save(path);
      flows.current.delete(path);
    }
    const d = docs.current.get(path);
    if (d) {
      if (discard) clearTimeout(d.timer);
      else if (docText(d.view) !== d.savedText) await save(path);
      d.view.destroy();
      docs.current.delete(path);
    }
    const remaining = tabsRef.current.filter((t) => t.path !== path);
    setTabs((ts) => ts.filter((t) => t.path !== path));
    if (active === path) setActive(remaining.length ? remaining[remaining.length - 1].path : null);
  };

  // Keep within the tab limit by closing the tabs viewed longest ago (close saves them first).
  const viewed = useRef(new Map<string, number>());
  const closing = useRef(new Set<string>());
  useEffect(() => {
    if (active) viewed.current.set(active, Date.now());
  }, [active]);
  useEffect(() => {
    const open = tabs.filter((t) => !closing.current.has(t.path));
    if (!p.tabLimit || open.length <= p.tabLimit) return;
    const seen = (path: string) => viewed.current.get(path) ?? 0;
    const oldest = open.filter((t) => t.path !== active).sort((a, b) => seen(a.path) - seen(b.path));
    for (const t of oldest.slice(0, open.length - p.tabLimit)) {
      closing.current.add(t.path);
      viewed.current.delete(t.path);
      void close(t.path).finally(() => closing.current.delete(t.path));
    }
  }, [tabs, active, p.tabLimit]);

  // ---------- Tab menu ----------

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pathRequest, setPathRequest] = useState<PathRequest | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  /** What the tab shows now, unsaved changes included, as file text. */
  const textOnScreen = (path: string): string => {
    const fl = flows.current.get(path);
    if (fl) return fl.handle?.text() ?? fl.text;
    const d = docs.current.get(path);
    return d ? (d.bom ? '\uFEFF' : '') + docText(d.view) : '';
  };

  const askPath = async (request: Omit<PathRequest, 'folders'>) => {
    const folders = new Set<string>(['/']);
    for (const f of await api.listFiles()) for (let dir = dirname(f); dir && dir !== '/'; dir = dirname(dir)) folders.add(dir);
    setPathRequest({ ...request, folders: [...folders].sort() });
  };

  /** Writes what the tab shows into a new file; false (with a message) when the name is taken. */
  const writeCopy = async (path: string, to: string) => {
    if (await api.exists(to)) {
      p.toast(`${to.slice(1)} already exists`);
      return false;
    }
    await api.writeText(to, textOnScreen(path));
    p.onSaved(to);
    return true;
  };

  const tabMenu = (t: NoteTab): MenuItem[] => {
    const path = t.path;
    const kind = isCanvas(path) ? 'flowchart' : 'note';
    return [
      { label: 'Save', disabled: !t.dirty, run: () => void save(path, true) },
      { label: 'Rename…', run: () => void askPath({ title: `Rename ${basename(path)}`, action: 'Rename', path, edit: 'name', run: (to) => void p.onRename(path, to) }) },
      { label: 'Move to…', run: () => void askPath({ title: `Move ${basename(path)}`, action: 'Move', path, edit: 'folder', run: (to) => void p.onRename(path, to) }) },
      {
        label: 'Save as…',
        run: () =>
          void askPath({
            title: `Save ${basename(path)} as`,
            action: 'Save',
            path,
            edit: 'both',
            run: async (to) => {
              if (!(await writeCopy(path, to))) return;
              // The tab moves to the new file; the old one keeps what was last saved.
              await close(path, true);
              await open(to);
            },
          }),
      },
      {
        label: 'Save a copy…',
        run: () =>
          void askPath({
            title: `Save a copy of ${basename(path)}`,
            action: 'Save a copy',
            path: `${dirname(path) === '/' ? '' : dirname(path)}/${stem(path)} copy${basename(path).slice(stem(path).length)}`,
            edit: 'both',
            run: async (to) => {
              if (await writeCopy(path, to)) p.toast(`Saved a copy as ${basename(to)}`);
            },
          }),
      },
      {
        label: `Copy link to this ${kind}`,
        run: async () => {
          // The link records the note itself, so it survives a rename or move.
          await save(path);
          const id = await api.ensureNoteId(path).catch(() => null);
          const d = docs.current.get(path);
          if (d && id) d.noteId = id;
          void api.copyText(formatReference(stem(path), { path, pathKind: 'root', loc: {}, extra: id ? [`id=${id}`] : [] }));
          p.toast('Link copied. Paste it into a note');
        },
      },
      'sep',
      { label: 'Export as a web page…', disabled: isCanvas(path), run: () => p.onExport(path, textOnScreen(path), 'html') },
      { label: 'Export as PDF…', disabled: isCanvas(path), run: () => p.onExport(path, textOnScreen(path), 'pdf') },
      { label: 'Export for someone without Locus…', disabled: isCanvas(path), run: () => p.onExport(path, textOnScreen(path), 'folder') },
      'sep',
      { label: 'Show in folder', run: () => void save(path).then(() => api.showInFolder(path)) },
      'sep',
      { label: 'Close', run: () => void close(path) },
      {
        label: 'Close others',
        disabled: tabs.length < 2,
        run: async () => {
          setActive(path);
          for (const other of tabsRef.current) if (other.path !== path) await close(other.path);
        },
      },
      'sep',
      {
        label: 'Delete…',
        danger: true,
        run: () => {
          const links = p.linksTo(path);
          setConfirm({
            title: `Delete ${basename(path)}?`,
            lines: [
              `This ${kind} goes to the Recycle Bin.`,
              ...(links ? [`${links} link${links === 1 ? '' : 's'} in other notes will be left pointing at nothing.`] : []),
              ...(t.dirty ? ['It has changes that were never saved.'] : []),
            ],
            action: 'Delete',
            run: async () => {
              try {
                await api.trashFile(path);
              } catch {
                p.toast(`Couldn't delete ${basename(path)}`);
                return;
              }
              await close(path, true);
              p.onDeleted(path);
              p.toast(`${basename(path)} is in the Recycle Bin`);
            },
          });
        },
      },
    ];
  };

  /** Tab being dragged to a new place in the row. */
  const dragged = useRef<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const moveTab = (id: string, beforeId: string) =>
    setTabs((ts) => {
      const moving = ts.find((t) => t.id === id);
      if (!moving || id === beforeId) return ts;
      const rest = ts.filter((t) => t.id !== id);
      const i = rest.findIndex((t) => t.id === beforeId);
      rest.splice(i < 0 ? rest.length : i, 0, moving);
      return rest;
    });

  const newNote = async () => {
    const files = new Set(await api.listFiles());
    let n = 1;
    let path = '/Untitled.md';
    while (files.has(path)) path = `/Untitled ${++n}.md`;
    await api.writeText(path, '# Untitled\n\n');
    return open(path);
  };

  const newFlowchart = async () => {
    const files = new Set(await api.listFiles());
    let n = 1;
    let path = '/Untitled flowchart.canvas';
    while (files.has(path)) path = `/Untitled flowchart ${++n}.canvas`;
    await api.writeText(path, serializeCanvas(newCanvas()));
    await openFlow(path);
  };

  const zoomRef = useRef(p.zoom);
  zoomRef.current = p.zoom;
  useEffect(() => {
    for (const d of docs.current.values()) setEditorZoom(d.view, p.zoom);
  }, [p.zoom]);

  useImperativeHandle(ref, () => ({
    activeView: () => (active ? docs.current.get(active)?.view ?? null : null),
    activeFlow: () => (active ? flows.current.get(active)?.handle ?? null : null),
    zoomFlow: (dir) => {
      const h = active ? flows.current.get(active)?.handle : null;
      h?.zoom(dir);
      return !!h;
    },
    activePath: () => active,
    activeText: () => (active && !isCanvas(active) ? textOnScreen(active) : ''),
    open,
    newNote,
    newFlowchart,
    saveAll: async () => {
      for (const path of [...docs.current.keys(), ...flows.current.keys()]) await save(path);
    },
    refresh: () => {
      for (const d of docs.current.values()) d.view.dispatch({ effects: refreshEffect.of(null) });
      for (const fl of flows.current.values()) fl.handle?.refresh();
    },
    revealHeading: (path, slug) => {
      const d = docs.current.get(path);
      if (!d) return;
      const doc = d.view.state.doc;
      for (let l = 1; l <= doc.lines; l++) {
        const line = doc.line(l);
        const m = line.text.match(/^#{1,6}\s+(.*)$/);
        if (m && slugify(m[1]) === slug) {
          flashRange(d.view, line.from, line.to);
          return;
        }
      }
    },
    handleMove: (from, to) => {
      const moved = (p: string) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
      const next = new Map<string, Doc>();
      for (const [p, d] of docs.current) {
        d.path = moved(p);
        next.set(d.path, d);
      }
      docs.current = next;
      const nextFlows = new Map<string, Flow>();
      for (const [p, fl] of flows.current) {
        fl.path = moved(p);
        nextFlows.set(fl.path, fl);
      }
      flows.current = nextFlows;
      const nextHosts = new Map<string, HTMLDivElement>();
      for (const [p, h] of hosts.current) nextHosts.set(moved(p), h);
      hosts.current = nextHosts;
      setTabs((ts) => ts.map((t) => ({ ...t, path: moved(t.path) })));
      setActive((a) => (a ? moved(a) : a));
    },
    revealLine: async (path, line) => {
      if (isCanvas(path)) {
        await openFlow(path);
        flows.current.get(path)?.handle?.revealLine(line);
        return;
      }
      const view = await open(path);
      if (view) requestAnimationFrame(() => flashLine(view, line));
    },
    reloadFromDisk: async () => {
      for (const [path, fl] of flows.current) {
        if ((fl.handle?.text() ?? fl.text) !== fl.savedText) continue;
        const bytes = await api.readFile(path).catch(() => null);
        if (!bytes) continue;
        const { text } = decodeText(bytes);
        if (text === fl.savedText) continue;
        fl.savedText = fl.text = text;
        fl.handle?.load(text);
      }
      for (const [path, d] of docs.current) {
        if (docText(d.view) !== d.savedText) continue;
        const bytes = await api.readFile(path).catch(() => null);
        if (!bytes) continue;
        const { body: text, id } = splitNoteId(decodeText(bytes).text);
        if (id) d.noteId = id;
        const normalized = text.replace(/\r\n/g, '\n');
        if (normalized === d.savedText.replace(/\r\n/g, '\n')) continue;
        d.view.dispatch({ changes: { from: 0, to: d.view.state.doc.length, insert: normalized } });
        d.savedText = docText(d.view);
        setDirty(path, false);
      }
    },
  }));

  useEffect(() => {
    (async () => {
      for (const path of p.initialPaths) await open(path);
      if (p.initialActive && docs.current.has(p.initialActive)) setActive(p.initialActive);
    })();
    return () => {
      for (const d of docs.current.values()) d.view.destroy();
      docs.current.clear();
    };
  }, []);

  useEffect(() => {
    p.onSessionChange(tabs.map((t) => t.path), active);
  }, [tabs, active]);

  useEffect(() => {
    const fl = active ? flows.current.get(active) : undefined;
    if (fl?.handle) setFlowZoom(fl.handle.getZoom());
    p.onActiveChange(active);
    showFormat(active ? docs.current.get(active)?.view : null);
    if (active) requestAnimationFrame(() => docs.current.get(active)?.view.requestMeasure());
  }, [active]);

  const view = () => (active ? docs.current.get(active)?.view ?? null : null);
  const activeIsFlow = !!active && isCanvas(active);
  const run = (fn: (v: EditorView) => unknown) => () => {
    const v = view();
    if (v) fn(v);
  };

  const tool = (icon: IconName, title: string, fn: (v: EditorView) => unknown, on = false, disabled = false) => (
    <button className={'icon' + (on ? ' active' : '')} aria-pressed={on} disabled={disabled} title={title} onMouseDown={(e) => e.preventDefault()} onClick={run(fn)}>
      <Icon name={icon} />
    </button>
  );

  return (
    <div className="pane" style={{ flex: 1 }}>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {pathRequest && <PathDialog request={pathRequest} onClose={() => setPathRequest(null)} />}
      {confirm && <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />}
      <div className="tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={'tab' + (t.path === active ? ' active' : '') + (dropBefore === t.id ? ' drop-before' : '')}
            title={t.path}
            draggable
            onDragStart={(e) => {
              dragged.current = t.id;
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              if (!dragged.current) return;
              e.preventDefault();
              setDropBefore(t.id);
            }}
            onDragLeave={() => setDropBefore((d) => (d === t.id ? null : d))}
            onDrop={() => dragged.current && moveTab(dragged.current, t.id)}
            onDragEnd={() => {
              dragged.current = null;
              setDropBefore(null);
            }}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                void close(t.path);
              } else if (e.button === 0) setActive(t.path);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, items: tabMenu(t) });
            }}
          >
            <span className="title">{basename(t.path)}</span>
            {t.dirty ? (
              <span className="dot">●</span>
            ) : (
              <span className="close" onMouseDown={(e) => { e.stopPropagation(); void close(t.path); }}><Icon name="x" size={12} /></span>
            )}
          </div>
        ))}
        <button className="tab-add" title="New note (Ctrl+N)" onClick={() => void newNote()}><Icon name="plus" size={14} /></button>
        <button className="tab-add" title="New flowchart" onClick={() => void newFlowchart()}><Icon name="flow" size={14} /></button>
        <div className="spacer" />
        {activeIsFlow ? (
          <ZoomControl zoom={flowZoom} onZoom={(z) => flows.current.get(active!)?.handle?.setZoom(z)} label="Flowchart" />
        ) : (
          <ZoomControl zoom={p.zoom} onZoom={p.onZoom} label="Notes" />
        )}
      </div>
      <div className="toolbar" style={{ display: activeIsFlow ? 'none' : undefined }}>
        <select
          title="Paragraph style"
          value={fmt.heading}
          onChange={(e) => {
            const v = view();
            if (v) setHeading(v, Number(e.target.value));
          }}
        >
          <option value="0">Paragraph</option>
          {[1, 2, 3, 4, 5, 6].map((l) => <option key={l} value={l}>Heading {l}</option>)}
        </select>
        <div className="sep" />
        {tool('bold', 'Bold (Ctrl+B)', (v) => toggleWrap(v, '**'), fmt.bold)}
        {tool('italic', 'Italic (Ctrl+I)', (v) => toggleWrap(v, '*'), fmt.italic)}
        {tool('strike', 'Strikethrough (Alt+Shift+5)', (v) => toggleWrap(v, '~~'), fmt.strike)}
        {tool('inlineCode', 'Inline code (Ctrl+E)', (v) => toggleWrap(v, '`'), fmt.code)}
        {tool('codeBlock', 'Code block (Ctrl+Shift+K)', (v) => insertBlock(v, '```\n\n```', 4))}
        <div className="sep" />
        {tool('list', 'Bulleted list (Ctrl+Shift+]) · Tab nests', (v) => toggleLinePrefix(v, '- '), fmt.list === 'bullet')}
        {tool('numList', 'Numbered list (Ctrl+Shift+[) · Tab nests', (v) => toggleLinePrefix(v, '1. '), fmt.list === 'number')}
        {tool('task', 'Task list (Ctrl+Shift+X)', (v) => toggleLinePrefix(v, '- [ ] '), fmt.list === 'task')}
        {tool('quote', 'Quote (Ctrl+Shift+Q)', (v) => toggleLinePrefix(v, '> '), fmt.quote)}
        {tool('table', 'Table (Ctrl+T)', (v) => insertTable(v))}
        {tool('hr', 'Horizontal rule', (v) => insertBlock(v, '---'))}
        {tool('link', 'Web link (Ctrl+K)', insertLink)}
        <div className="sep" />
        <div className="sep" />
        <button className="icon" title="Link to a section of a note (Ctrl+Alt+L)" onMouseDown={(e) => e.preventDefault()} onClick={p.onLinkSection}>
          <Icon name="bookmark" />
        </button>
        <div className="sep" />
        {tool('undo', 'Undo (Ctrl+Z)', editorUndo, false, !fmt.canUndo)}
        {tool('redo', 'Redo (Ctrl+Y)', editorRedo, false, !fmt.canRedo)}
        <div className="spacer" />
        <button className={'pill' + (p.touring ? ' active' : '')} title="Step through this note's references (Ctrl+Shift+T)" onClick={p.onTour}>
          <Icon name="presentation" /> Tour
        </button>
      </div>
      {tabs.length === 0 && (
        <div className="empty">
          <h3>No note open</h3>
          <div>Open one with <b>Open</b> at the top and choose Edit, or start a new one.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="outline" onClick={() => void newNote()}><Icon name="plus" /> New note</button>
            <button className="outline" onClick={() => void newFlowchart()}><Icon name="flow" /> New flowchart</button>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>Ctrl+O to find a file by name</div>
        </div>
      )}
      {tabs.map((t) => {
        const fl = flows.current.get(t.path);
        if (!fl) return null;
        return (
          <div key={t.id} className="flow-wrap" style={{ display: t.path === active ? 'flex' : 'none' }}>
            <FlowEditor
              initialText={fl.initialText}
              callbacks={p.callbacks(() => fl.path)}
              onChange={(text) => {
                fl.text = text;
                setDirty(fl.path, text !== fl.savedText);
                clearTimeout(fl.timer);
                if (autosaveRef.current) fl.timer = window.setTimeout(() => void save(fl.path), 900);
              }}
              onSave={() => void save(fl.path, true)}
              register={(h) => (fl.handle = h)}
              onZoomChange={(z) => fl.path === activeRef.current && setFlowZoom(z)}
            />
          </div>
        );
      })}
      {tabs.filter((t) => !isCanvas(t.path)).map((t) => (
        <div
          key={t.id}
          className="editor-wrap"
          style={{ display: t.path === active ? 'flex' : 'none' }}
          ref={(el) => {
            if (el) hosts.current.set(t.path, el);
            else hosts.current.delete(t.path);
          }}
        />
      ))}
    </div>
  );
});
