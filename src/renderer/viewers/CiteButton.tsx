// The Cite button every viewer shows, split so the kind of link can be chosen: Live (always the
// latest file) or Pinned (this exact version). Viewing an older version always cites it pinned.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../icons';

export type CiteMode = 'live' | 'pinned';

export const CiteModeContext = createContext<{ mode: CiteMode; setMode(m: CiteMode): void; pinnedOnly: boolean }>({
  mode: 'live',
  setMode: () => undefined,
  pinnedOnly: false,
});

const MODES: [CiteMode, string, string][] = [
  ['live', 'Live', 'Opens the latest version of the file and warns you if it changed since you cited it.'],
  ['pinned', 'Pinned', 'Always opens this exact version, even after the file changes.'],
];

export function CiteButton({ icon, label, title, onCite }: { icon: IconName; label: string; title?: string; onCite(): void }) {
  const { mode, setMode, pinnedOnly } = useContext(CiteModeContext);
  const shown: CiteMode = pinnedOnly ? 'pinned' : mode;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="cite-split" ref={ref}>
      <button className="cite" onClick={onCite} title={title ?? 'Insert a link to this into the note (Ctrl+Shift+L)'}>
        <Icon name={icon} /> {label}
        <span className={'cite-kind ' + shown}>{shown === 'live' ? 'Live' : 'Pinned'}</span>
      </button>
      <button className="cite cite-more" title="Choose what kind of link to insert" onClick={() => setOpen(!open)}>
        <Icon name="chevDown" size={12} />
      </button>
      {open && (
        <div className="popover cite-mode-menu">
          {MODES.map(([m, name, desc]) => {
            const disabled = pinnedOnly && m === 'live';
            return (
              <button
                key={m}
                className={'menu-item' + (shown === m ? ' selected' : '')}
                disabled={disabled}
                onClick={() => {
                  setMode(m);
                  setOpen(false);
                }}
              >
                <span className="name">
                  {shown === m ? <Icon name="check" size={13} /> : <span className="check-space" />} {name}
                </span>
                <span className="desc">{disabled ? 'You are viewing an older version, so links to it are pinned.' : desc}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
