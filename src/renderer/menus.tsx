import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { basename, dirname } from '../core/link';

export type MenuItem = { label: string; run(): void; danger?: boolean; disabled?: boolean } | 'sep';

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** A right-click menu at a point; closes on a click elsewhere, Esc, or after an item runs. */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose(): void }) {
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const r = el.current!.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(menu.x, innerWidth - r.width - 4)), y: Math.max(4, Math.min(menu.y, innerHeight - r.height - 4)) });
  }, [menu]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !el.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
    };
  }, []);
  return (
    <div ref={el} className="popover context-menu" role="menu" style={{ position: 'fixed', left: pos.x, top: pos.y }}>
      {menu.items.map((item, i) =>
        item === 'sep' ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={'menu-item' + (item.danger ? ' danger' : '')}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

export interface PathRequest {
  title: string;
  /** Label of the confirming button. */
  action: string;
  /** Where the file is now (or the proposed place for a new one). */
  path: string;
  /** Which part can be changed. */
  edit: 'name' | 'folder' | 'both';
  /** Existing folders, offered as suggestions. */
  folders: string[];
  run(path: string): void;
}

const BAD_NAME = /[<>:"/\\|?*]/;

/** Asks for a file's name and folder (Rename, Move to, Save as, Save a copy). */
export function PathDialog({ request, onClose }: { request: PathRequest; onClose(): void }) {
  const dot = basename(request.path).lastIndexOf('.');
  const ext = dot > 0 ? basename(request.path).slice(dot) : '';
  const [name, setName] = useState(basename(request.path).slice(0, basename(request.path).length - ext.length));
  const [folder, setFolder] = useState(dirname(request.path) || '/');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, []);
  const cleanFolder = '/' + folder.replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean).join('/');
  const target = (cleanFolder === '/' ? '' : cleanFolder) + '/' + name.trim() + ext;
  const problem = !name.trim()
    ? 'Give it a name'
    : BAD_NAME.test(name)
      ? 'A name can\'t contain < > : " / \\ | ? *'
      : cleanFolder.split('/').some((s) => s === '..' || s.startsWith('.locus') || /[<>:"|?*]/.test(s))
        ? 'That folder can\'t be used'
        : target === request.path && request.edit !== 'both'
          ? ''
          : null;
  const submit = () => {
    if (problem !== null) return;
    onClose();
    request.run(target);
  };
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="locus-dialog path-dialog"
        style={{ width: 440 }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div className="dialog-head"><h2>{request.title}</h2></div>
        <div className="dialog-body" style={{ display: 'grid', gap: 10 }}>
          {request.edit !== 'folder' && (
            <label className="field">
              <span>Name</span>
              <span className="with-suffix">
                <input ref={first} aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
                <span className="muted">{ext}</span>
              </span>
            </label>
          )}
          {request.edit !== 'name' && (
            <label className="field">
              <span>Folder</span>
              <input ref={request.edit === 'folder' ? first : undefined} aria-label="Folder" list="path-dialog-folders" value={folder} onChange={(e) => setFolder(e.target.value)} />
              <datalist id="path-dialog-folders">
                {request.folders.map((f) => <option key={f} value={f} />)}
              </datalist>
              <span className="muted hint">/ is the top of the workspace. A folder that doesn't exist yet is created.</span>
            </label>
          )}
          {problem && <div className="field-error">{problem}</div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={problem !== null}>{request.action}</button>
        </div>
      </form>
    </div>
  );
}

export interface ConfirmRequest {
  title: string;
  lines: string[];
  action: string;
  run(): void;
}

/** A yes/no question for something that can't be undone in the app. Cancel is the default. */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose(): void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="locus-dialog confirm-dialog" style={{ width: 440 }}>
        <div className="dialog-head"><h2>{request.title}</h2></div>
        <div className="dialog-body" style={{ display: 'grid', gap: 6 }}>
          {request.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
        <div className="dialog-foot">
          <button ref={cancel} className="outline" onClick={onClose}>Cancel</button>
          <button
            className="danger"
            onClick={() => {
              onClose();
              request.run();
            }}
          >
            {request.action}
          </button>
        </div>
      </div>
    </div>
  );
}
