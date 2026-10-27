import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { basename, slugify } from '../../core/link';
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
  insertBlock,
  insertLink,
  refreshEffect,
  setHeading,
  toggleLinePrefix,
  toggleWrap,
  type NoteEditorOptions,
} from './editor';
import { insertTable } from './tables';
import { setEditorZoom, ZoomControl } from '../zoom';
import { isCanvas, newCanvas, serializeCanvas } from '../../core/canvas';
import { FlowEditor, type FlowHandle } from '../flow/FlowEditor';

export interface NotesHandle {
  activeView(): EditorView | null;
  /** The flowchart in the active tab, if it is one. */
  activeFlow(): FlowHandle | null;
  /** Zooms the active flowchart's view; false when the active tab isn't a flowchart. */
  zoomFlow(dir: 1 | -1 | 0): boolean;
  activePath(): string | null;
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
  /** Zoom of the notes editor, separate from the documents'. */
  zoom: number;
  onZoom(z: number): void;
  /** Called after a note is written to disk. */
  onSaved(path: string): void;
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
  const autosaveRef = useRef(p.autosave);
  autosaveRef.current = p.autosave;

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
      await api.writeText(path, (d.bom ? '﻿' : '') + text);
      d.savedText = text;
      p.onSaved(path);
    }
    setDirty(path, false);
    if (announce) p.toast(`Saved ${basename(path)}`);
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
      const { text, bom, eol } = decodeText(bytes);
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
      const doc = { path, bom, savedText: text } as Doc;
      const cb = p.callbacks(() => doc.path);
      doc.view = createNoteEditor(host, {
        doc: text,
        eol,
        zoom: zoomRef.current,
        ...cb,
        onSave: () => void save(doc.path, true),
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

  const close = async (path: string) => {
    if (flows.current.has(path)) {
      await save(path);
      flows.current.delete(path);
    }
    const d = docs.current.get(path);
    if (d) {
      if (docText(d.view) !== d.savedText) await save(path);
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
        const { text } = decodeText(bytes);
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
    if (active) requestAnimationFrame(() => docs.current.get(active)?.view.requestMeasure());
  }, [active]);

  const view = () => (active ? docs.current.get(active)?.view ?? null : null);
  const activeIsFlow = !!active && isCanvas(active);
  const activeRef = useRef(active);
  activeRef.current = active;
  const run = (fn: (v: EditorView) => unknown) => () => {
    const v = view();
    if (v) fn(v);
  };

  const tool = (icon: IconName, title: string, fn: (v: EditorView) => unknown) => (
    <button className="icon" title={title} onMouseDown={(e) => e.preventDefault()} onClick={run(fn)}>
      <Icon name={icon} />
    </button>
  );

  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={'tab' + (t.path === active ? ' active' : '')}
            title={t.path}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                void close(t.path);
              } else setActive(t.path);
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
          value=""
          onChange={(e) => {
            const v = view();
            if (v) setHeading(v, Number(e.target.value));
          }}
        >
          <option value="" disabled>Style</option>
          <option value="0">Paragraph</option>
          {[1, 2, 3, 4, 5, 6].map((l) => <option key={l} value={l}>Heading {l}</option>)}
        </select>
        <div className="sep" />
        {tool('bold', 'Bold (Ctrl+B)', (v) => toggleWrap(v, '**'))}
        {tool('italic', 'Italic (Ctrl+I)', (v) => toggleWrap(v, '*'))}
        {tool('strike', 'Strikethrough', (v) => toggleWrap(v, '~~'))}
        {tool('inlineCode', 'Inline code (Ctrl+E)', (v) => toggleWrap(v, '`'))}
        {tool('codeBlock', 'Code block', (v) => insertBlock(v, '```\n\n```', 4))}
        <div className="sep" />
        {tool('list', 'Bulleted list', (v) => toggleLinePrefix(v, '- '))}
        {tool('numList', 'Numbered list', (v) => toggleLinePrefix(v, '1. '))}
        {tool('task', 'Task list', (v) => toggleLinePrefix(v, '- [ ] '))}
        {tool('quote', 'Quote', (v) => toggleLinePrefix(v, '> '))}
        {tool('table', 'Table', (v) => insertTable(v))}
        {tool('hr', 'Horizontal rule', (v) => insertBlock(v, '---'))}
        {tool('link', 'Web link (Ctrl+K)', insertLink)}
        <div className="sep" />
        {tool('undo', 'Undo (Ctrl+Z)', editorUndo)}
        {tool('redo', 'Redo (Ctrl+Y)', editorRedo)}
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
