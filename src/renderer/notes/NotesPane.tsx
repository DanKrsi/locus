import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { basename, slugify } from '../../core/link';
import { api } from '../api';
import { decodeText } from '../files';
import { Icon, type IconName } from '../icons';
import type { NoteTab } from '../model';
import {
  createNoteEditor,
  docText,
  editorRedo,
  editorUndo,
  flashRange,
  insertBlock,
  insertLink,
  refreshEffect,
  setHeading,
  toggleLinePrefix,
  toggleWrap,
  type NoteEditorOptions,
} from './editor';

export interface NotesHandle {
  activeView(): EditorView | null;
  activePath(): string | null;
  open(path: string): Promise<EditorView | null>;
  newNote(): Promise<EditorView | null>;
  saveAll(): Promise<void>;
  /** Re-render references (after link checks or version changes). */
  refresh(): void;
  revealHeading(path: string, slug: string): void;
  reloadFromDisk(): Promise<void>;
}

type EditorCallbacks = Pick<NoteEditorOptions, 'onFollow' | 'refStatus' | 'imageUrl' | 'renderHoverCard'>;

interface Props {
  initialPaths: string[];
  initialActive: string | null;
  autosave: boolean;
  callbacks(path: string): EditorCallbacks;
  onSessionChange(paths: string[], active: string | null): void;
  onActiveChange(path: string | null): void;
  toast(msg: string): void;
}

interface Doc {
  view: EditorView;
  bom: boolean;
  savedText: string;
  timer?: number;
}

export const NotesPane = forwardRef<NotesHandle, Props>(function NotesPane(p, ref) {
  const [tabs, setTabs] = useState<NoteTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const docs = useRef(new Map<string, Doc>());
  const hosts = useRef(new Map<string, HTMLDivElement>());
  const pending = useRef(new Map<string, Promise<EditorView | null>>());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const autosaveRef = useRef(p.autosave);
  autosaveRef.current = p.autosave;

  const setDirty = (path: string, dirty: boolean) =>
    setTabs((ts) => ts.map((t) => (t.path === path && t.dirty !== dirty ? { ...t, dirty } : t)));

  const save = async (path: string, announce = false) => {
    const d = docs.current.get(path);
    if (!d) return;
    clearTimeout(d.timer);
    const text = docText(d.view);
    if (text !== d.savedText) {
      await api.writeText(path, (d.bom ? '﻿' : '') + text);
      d.savedText = text;
    }
    setDirty(path, false);
    if (announce) p.toast(`Saved ${basename(path)}`);
  };

  const open = (path: string): Promise<EditorView | null> => {
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
      setTabs((ts) => (ts.some((t) => t.path === path) ? ts : [...ts, { path, dirty: false }]));
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
      const cb = p.callbacks(path);
      const view = createNoteEditor(host, {
        doc: text,
        eol,
        ...cb,
        onSave: () => void save(path, true),
        onChange: () => {
          const d = docs.current.get(path);
          if (!d) return;
          setDirty(path, docText(d.view) !== d.savedText);
          clearTimeout(d.timer);
          if (autosaveRef.current) d.timer = window.setTimeout(() => void save(path), 900);
        },
      });
      docs.current.set(path, { view, bom, savedText: text });
      return view;
    })();
    pending.current.set(path, promise);
    promise.finally(() => pending.current.delete(path));
    return promise;
  };

  const close = async (path: string) => {
    const d = docs.current.get(path);
    if (d) {
      if (docText(d.view) !== d.savedText) await save(path);
      d.view.destroy();
      docs.current.delete(path);
    }
    const remaining = tabsRef.current.filter((t) => t.path !== path);
    setTabs(remaining);
    if (active === path) setActive(remaining.length ? remaining[remaining.length - 1].path : null);
  };

  const newNote = async () => {
    const files = new Set(await api.listFiles());
    let n = 1;
    let path = '/Untitled.md';
    while (files.has(path)) path = `/Untitled ${++n}.md`;
    await api.writeText(path, '# Untitled\n\n');
    return open(path);
  };

  useImperativeHandle(ref, () => ({
    activeView: () => (active ? docs.current.get(active)?.view ?? null : null),
    activePath: () => active,
    open,
    newNote,
    saveAll: async () => {
      for (const path of docs.current.keys()) await save(path);
    },
    refresh: () => {
      for (const d of docs.current.values()) d.view.dispatch({ effects: refreshEffect.of(null) });
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
    reloadFromDisk: async () => {
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
    p.onActiveChange(active);
    if (active) requestAnimationFrame(() => docs.current.get(active)?.view.requestMeasure());
  }, [active]);

  const view = () => (active ? docs.current.get(active)?.view ?? null : null);
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
            key={t.path}
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
      </div>
      <div className="toolbar">
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
        {tool('table', 'Table', (v) => insertBlock(v, '| Column | Column |\n| --- | --- |\n|  |  |', 2))}
        {tool('hr', 'Horizontal rule', (v) => insertBlock(v, '---'))}
        {tool('link', 'Web link (Ctrl+K)', insertLink)}
        <div className="sep" />
        {tool('undo', 'Undo (Ctrl+Z)', editorUndo)}
        {tool('redo', 'Redo (Ctrl+Y)', editorRedo)}
      </div>
      {tabs.length === 0 && (
        <div className="empty">
          <h3>No note open</h3>
          <div>Notes are markdown files in this workspace.</div>
          <button className="primary" onClick={() => void newNote()}><Icon name="plus" /> New note</button>
        </div>
      )}
      {tabs.map((t) => (
        <div
          key={t.path}
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
