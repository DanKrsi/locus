// Link to a section (UI spec §4.6): the headings of this note as it is on screen, or of any
// other note, filtered as you type. Enter inserts the link at the cursor.
import { useEffect, useMemo, useRef, useState } from 'react';
import { basename, dirname, headings, type Heading } from '../core/link';
import { api } from './api';
import { Icon } from './icons';

interface Props {
  notePath: string;
  /** The note as written on screen, so headings typed but not saved are offered too. */
  noteText: string;
  onInsert(path: string | null, heading: Heading): void;
  onClose(): void;
}

export function SectionLink(p: Props) {
  const [notes, setNotes] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [text, setText] = useState(p.noteText);
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api
      .listFiles()
      .then((f) => setNotes(f.filter((x) => /\.md$/i.test(x))))
      .catch(() => setNotes([]));
    input.current?.focus();
  }, []);

  useEffect(() => {
    if (!target) return setText(p.noteText);
    void api.readText(target).then(setText).catch(() => setText(''));
  }, [target]);

  const all = useMemo(() => headings(text), [text]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? all.filter((h) => h.text.toLowerCase().includes(q)) : all;
  }, [all, filter]);
  useEffect(() => setCursor(0), [shown.length, target]);

  const insert = (h: Heading | undefined) => {
    if (!h) return;
    p.onInsert(target || null, h);
  };

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="locus-dialog" style={{ width: 520 }} onKeyDown={(e) => e.key === 'Escape' && p.onClose()}>
        <div className="dialog-head">
          <h2>Link to a section</h2>
          <div className="spacer" />
          <select aria-label="Note" value={target} onChange={(e) => setTarget(e.target.value)} style={{ maxWidth: 260 }}>
            <option value="">This note{p.notePath ? ` (${basename(p.notePath)})` : ''}</option>
            {notes
              .filter((n) => n !== p.notePath)
              .map((n) => (
                <option key={n} value={n}>
                  {basename(n)}
                  {dirname(n) === '/' ? '' : ` · ${dirname(n).slice(1)}`}
                </option>
              ))}
          </select>
        </div>
        <div style={{ padding: '0 16px 10px' }}>
          <input
            ref={input}
            style={{ width: '100%' }}
            placeholder="Find a section by name"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, shown.length - 1));
              else if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0));
              else if (e.key === 'Enter') insert(shown[cursor]);
              else return;
              e.preventDefault();
            }}
          />
        </div>
        <div className="dialog-body tree" style={{ minHeight: 220 }}>
          {shown.map((h, i) => (
            <div
              key={`${h.line}:${h.slug}`}
              className="tree-row"
              style={{ paddingLeft: 8 + (h.level - 1) * 16, ...(i === cursor ? { background: 'var(--accent-soft)' } : {}) }}
              onClick={() => insert(h)}
            >
              <Icon name="bookmark" size={13} />
              <span className="name">{h.text}</span>
              <span className="spacer" />
              <span className="muted" style={{ fontSize: 12 }}>Heading {h.level}</span>
            </div>
          ))}
          {!shown.length && <div className="muted" style={{ padding: 8 }}>{all.length ? 'No section matches.' : 'This note has no headings yet.'}</div>}
        </div>
        <div className="dialog-foot">
          <div className="spacer" />
          <button className="outline" onClick={p.onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const KEYS: [string, string][] = [
  ['Save', 'Ctrl+S'],
  ['New note', 'Ctrl+N'],
  ['Open a file', 'Ctrl+O or Ctrl+P'],
  ['Save version', 'Ctrl+Shift+S'],
  ['Cite what is shown on the right', 'Ctrl+Shift+L'],
  ['Link to a section', 'Ctrl+Alt+L'],
  ['Tour mode', 'Ctrl+Shift+T'],
  ['Find in the note or document', 'Ctrl+F'],
  ['Zoom the pane you are in', 'Ctrl+= / Ctrl+− or Ctrl+wheel'],
  ['Paragraph, heading 1–6', 'Ctrl+0 … Ctrl+6'],
  ['Bold, italic, strikethrough, code', 'Ctrl+B, Ctrl+I, Alt+Shift+5, Ctrl+E'],
  ['Web link', 'Ctrl+K'],
  ['Code block, quote', 'Ctrl+Shift+K, Ctrl+Shift+Q'],
  ['Bulleted, numbered, task list', 'Ctrl+Shift+], Ctrl+Shift+[, Ctrl+Shift+X'],
  ['Table', 'Ctrl+T'],
  ['Nest / un-nest a list item', 'Tab / Shift+Tab'],
  ['Undo, redo', 'Ctrl+Z, Ctrl+Y'],
  ['This list', 'F1'],
];

export function Shortcuts({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => (e.key === 'Escape' || e.key === 'F1') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="locus-dialog" style={{ width: 560 }}>
        <div className="dialog-head"><h2>Keyboard shortcuts</h2></div>
        <div className="dialog-body">
          <table className="shortcuts">
            <tbody>
              {KEYS.map(([what, keys]) => (
                <tr key={what}>
                  <td>{what}</td>
                  <td><kbd>{keys}</kbd></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dialog-foot">
          <div className="spacer" />
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
