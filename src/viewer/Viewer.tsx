// The viewer people without Locus get: the note on the left, and the documents it cites opening
// on the right at the exact place, using the same viewers as the app. Everything it shows is
// embedded in the folder beside it, so it runs from a disk or an email attachment with no server.
import { useEffect, useMemo, useRef, useState } from 'react';
import { basename, fileKind, type FileKind, type Location } from '../core/link';
import { CodeViewer } from '../renderer/viewers/CodeViewer';
import { ImageViewer, MediaViewer } from '../renderer/viewers/OtherViewers';
import { PdfViewer } from '../renderer/viewers/PdfViewer';
import { SheetViewer } from '../renderer/viewers/SheetViewer';
import { SlidesViewer } from '../renderer/viewers/SlidesViewer';
import { Icon, kindIcon, Logo } from '../renderer/icons';
import { ZoomControl } from '../renderer/zoom';
import type { RevealRequest, ViewerHandle } from '../renderer/viewers/types';

export interface ExportedFile {
  /** Workspace path, for the tab's name and the file's kind. */
  path: string;
  /** The version this link cited, when it isn't the latest. */
  rev?: string;
  /** How the version reads to a person ("the version of 3 March 2026"). */
  revLabel?: string;
  /** Base64, or absent when the file could not be included. */
  data?: string;
  /** Where the plain copy sits in the folder, for Save a copy. */
  copy?: string;
}

export interface ExportedNote {
  path: string;
  title: string;
  html: string;
}

export interface ExportData {
  workspace: string;
  /** The note the export is of; the first one shown. */
  main: string;
  notes: Record<string, ExportedNote>;
  files: Record<string, ExportedFile>;
  exported: string;
}

declare global {
  interface Window {
    LOCUS_EXPORT: ExportData;
    LOCUS_FILES: Record<string, string>;
  }
}

/** The key a link uses for a file: its path, and the version when it cited one. */
export const fileKey = (path: string, rev?: string) => (rev ? `${path}@${rev}` : path);

const bytesCache = new Map<string, Uint8Array>();

function bytesOf(key: string): Uint8Array | null {
  const cached = bytesCache.get(key);
  if (cached) return cached;
  const b64 = window.LOCUS_FILES?.[key];
  if (!b64) return null;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  bytesCache.set(key, out);
  return out;
}

interface Tab {
  id: number;
  /** A document, or a note shown as a page. */
  kind: 'file' | 'note';
  key: string;
  path: string;
  rev?: string;
  revLabel?: string;
  reveal?: RevealRequest;
}

let nextId = 1;
let nonce = 1;

/** What a link in a note points at, read from the attributes the export wrote. */
function targetOf(a: HTMLAnchorElement): { path: string; rev?: string; loc: Location } | null {
  const path = a.getAttribute('data-path');
  if (!path) return null;
  let loc: Location = {};
  try {
    loc = JSON.parse(a.getAttribute('data-loc') || '{}');
  } catch {
    /* a link with no place opens the file */
  }
  return { path, rev: a.getAttribute('data-rev') ?? undefined, loc };
}

export function Viewer() {
  const data = window.LOCUS_EXPORT;
  const [noteShown, setNoteShown] = useState(data.main);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [noteZoom, setNoteZoom] = useState(1);
  const [split, setSplit] = useState(0.5);
  const [dragging, setDragging] = useState(false);
  const handles = useRef(new Map<number, ViewerHandle | null>());
  const noteHost = useRef<HTMLDivElement>(null);

  const note = data.notes[noteShown];

  const open = (path: string, rev: string | undefined, loc: Location) => {
    // A note opens on the left, where it is read; anything else on the right.
    if (data.notes[path] && !rev) {
      setNoteShown(path);
      noteHost.current?.scrollTo({ top: 0 });
      if (loc.heading) setTimeout(() => document.getElementById(loc.heading!)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
      return;
    }
    const key = fileKey(path, rev);
    const file = data.files[key];
    const reveal: RevealRequest = { loc, nonce: nonce++ };
    setTabs((ts) => {
      const found = ts.find((t) => t.key === key);
      if (found) {
        setActive(found.id);
        return ts.map((t) => (t.id === found.id ? { ...t, reveal } : t));
      }
      const tab: Tab = { id: nextId++, kind: 'file', key, path, rev, revLabel: file?.revLabel, reveal };
      setActive(tab.id);
      return [...ts, tab];
    });
  };

  // Links in the note open what they cite.
  useEffect(() => {
    const host = noteHost.current;
    if (!host) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a');
      if (!a) return;
      const t = targetOf(a as HTMLAnchorElement);
      if (!t) return; // a plain web link opens as usual
      e.preventDefault();
      open(t.path, t.rev, t.loc);
    };
    host.addEventListener('click', onClick);
    return () => host.removeEventListener('click', onClick);
  }, [noteShown]);

  useEffect(() => {
    document.title = `${note?.title ?? data.main} · ${data.workspace}`;
  }, [noteShown]);

  const activeTab = tabs.find((t) => t.id === active);

  return (
    <div className="app viewer-app" data-mode="light">
      <div className="header">
        <Logo />
        <span className="ws-name" title={`Exported from ${data.workspace}`}>{data.workspace}</span>
        <span className="muted" style={{ fontSize: 12.5 }}>a Locus note · read-only</span>
        <div className="spacer" />
        <a className="muted" style={{ fontSize: 12.5 }} href="https://github.com/DanKrsi/locus" target="_blank" rel="noreferrer">
          Made with Locus
        </a>
      </div>
      <div
        className="panes"
        onMouseMove={(e) => {
          if (!dragging) return;
          const r = e.currentTarget.getBoundingClientRect();
          setSplit(Math.min(0.8, Math.max(0.2, (e.clientX - r.left) / r.width)));
        }}
        onMouseUp={() => setDragging(false)}
        onMouseLeave={() => setDragging(false)}
      >
        <div data-pane="notes" style={{ width: `${split * 100}%`, display: 'flex', minWidth: 0 }}>
          <div className="pane" style={{ flex: 1 }}>
            <div className="tabs">
              {Object.values(data.notes).map((n) => (
                <div
                  key={n.path}
                  className={'tab' + (n.path === noteShown ? ' active' : '')}
                  title={n.path}
                  onMouseDown={() => setNoteShown(n.path)}
                >
                  <Icon name="note" size={14} />
                  <span className="title">{n.title}</span>
                </div>
              ))}
              <div className="spacer" />
              <ZoomControl zoom={noteZoom} onZoom={setNoteZoom} label="Note" />
            </div>
            <div className="note-page" ref={noteHost} style={{ fontSize: `${noteZoom}em` }}>
              <main className="note" dangerouslySetInnerHTML={{ __html: note?.html ?? '' }} />
            </div>
          </div>
        </div>
        <div className="divider" onMouseDown={() => setDragging(true)} onDoubleClick={() => setSplit(0.5)} />
        <div data-pane="docs" style={{ flex: 1, display: 'flex', minWidth: 0 }}>
          <div className="pane" style={{ flex: 1 }}>
            <div className="tabs">
              {tabs.map((t) => (
                <div key={t.id} className={'tab' + (t.id === active ? ' active' : '')} title={t.path} onMouseDown={(e) => (e.button === 1 ? closeTab(t.id) : setActive(t.id))}>
                  <Icon name={kindIcon(fileKind(t.path))} size={14} />
                  <span className="title">{basename(t.path)}</span>
                  {t.revLabel && <span className="badge mark">{t.revLabel}</span>}
                  <span className="close" onMouseDown={(e) => { e.stopPropagation(); closeTab(t.id); }}><Icon name="x" size={12} /></span>
                </div>
              ))}
            </div>
            {!tabs.length && (
              <div className="empty">
                <h3>Nothing open yet</h3>
                <div>Click a green link in the note to open what it points at, right at the spot.</div>
              </div>
            )}
            {tabs.map((t) => (
              <Doc key={t.id} tab={t} visible={t.id === active} zoom={zoom} onZoom={setZoom} handles={handles} files={data.files} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  function closeTab(id: number) {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.id === id);
      const rest = ts.filter((t) => t.id !== id);
      if (active === id) setActive(rest[Math.min(i, rest.length - 1)]?.id ?? null);
      return rest;
    });
    handles.current.delete(id);
  }
}

function Doc({
  tab,
  visible,
  zoom,
  onZoom,
  handles,
  files,
}: {
  tab: Tab;
  visible: boolean;
  zoom: number;
  onZoom(z: number): void;
  handles: React.RefObject<Map<number, ViewerHandle | null>>;
  files: Record<string, ExportedFile>;
}) {
  const info = files[tab.key];
  const data = useMemo(() => bytesOf(tab.key), [tab.key]);
  const kind: FileKind = fileKind(tab.path);
  const props = {
    data: data!,
    path: tab.path,
    reveal: tab.reveal,
    onCite: () => undefined,
    handle: (h: ViewerHandle | null) => handles.current?.set(tab.id, h),
    zoom,
    children: kind !== 'pdf' && kind !== 'media' ? <ZoomControl zoom={zoom} onZoom={onZoom} label="Document" /> : undefined,
  };
  let body: React.ReactNode;
  if (!data) {
    body = (
      <div className="empty">
        <h3>{basename(tab.path)} isn't in this folder</h3>
        <div>{info ? 'It could not be included in the export.' : 'The note links to it, but it was left out.'}</div>
      </div>
    );
  } else {
    switch (kind) {
      case 'pdf':
        body = <PdfViewer {...props} />;
        break;
      case 'sheet':
        body = <SheetViewer {...props} />;
        break;
      case 'image':
        body = <ImageViewer {...props} />;
        break;
      case 'media':
        body = <MediaViewer {...props} />;
        break;
      case 'slides':
        body = <SlidesViewer {...props} />;
        break;
      case 'code':
      case 'markdown':
        body = <CodeViewer {...props} />;
        break;
      default:
        body = <SaveACopy path={tab.path} bytes={data} />;
    }
  }
  return <div className={'viewer' + (visible ? '' : ' hidden')}>{body}</div>;
}

/** Files the viewer can't draw (flowcharts, Word documents) can still be taken out of the folder. */
function SaveACopy({ path, bytes }: { path: string; bytes: Uint8Array }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes as BlobPart])), [bytes]);
  return (
    <div className="empty">
      <h3>No preview for {basename(path)}</h3>
      <div>This kind of file opens in the program that made it.</div>
      <a className="choice" style={{ width: 'auto' }} href={url} download={basename(path)}>
        <span><Icon name="download" /> <b>Save a copy</b></span>
      </a>
    </div>
  );
}
