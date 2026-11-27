import { useEffect, useMemo, useRef, useState } from 'react';
import { extname, formatTime } from '../../core/link';
import { mimeFor } from '../files';
import { Icon } from '../icons';
import { CiteButton } from './CiteButton';
import type { ViewerProps } from './types';

function useObjectUrl(data: Uint8Array, path: string) {
  const url = useMemo(() => URL.createObjectURL(new Blob([data as BlobPart], { type: mimeFor(extname(path)) })), [data, path]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return url;
}

export function ImageViewer({ data, path, onCite, handle, zoom = 1, children }: ViewerProps) {
  const url = useObjectUrl(data, path);
  const [natural, setNatural] = useState(0);
  useEffect(() => {
    handle({ citeTarget: () => ({ loc: {} }) });
    return () => handle(null);
  }, []);
  return (
    <>
      <div className="toolbar">
        {children}
        <div className="spacer" />
        <CiteButton icon="image" label="Cite image" onCite={onCite} />
      </div>
      <div className="image-viewer">
        <img
          src={url}
          alt=""
          onLoad={(e) => setNatural(e.currentTarget.naturalWidth)}
          style={zoom === 1 || !natural ? undefined : { width: `calc(min(${natural}px, 100%) * ${zoom})`, maxWidth: 'none' }}
        />
      </div>
    </>
  );
}

export function MediaViewer({ data, path, reveal, onCite, handle, children }: ViewerProps) {
  const url = useObjectUrl(data, path);
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const isVideo = /^(mp4|webm|mov)$/.test(extname(path));
  useEffect(() => {
    handle({ citeTarget: () => ({ loc: { time: Math.floor(ref.current?.currentTime ?? 0) } }) });
    return () => handle(null);
  }, []);
  useEffect(() => {
    if (reveal?.loc.time !== undefined && ref.current) {
      ref.current.currentTime = reveal.loc.time;
      ref.current.play().catch(() => undefined);
    }
  }, [reveal]);
  const props = { ref, src: url, controls: true, onTimeUpdate: () => setTime(ref.current?.currentTime ?? 0) };
  return (
    <>
      <div className="toolbar">
        {children}
        <span className="muted">{formatTime(time)}</span>
        <div className="spacer" />
        <CiteButton icon="play" label="Cite time" onCite={onCite} />
      </div>
      <div className="media-viewer">{isVideo ? <video {...props} /> : <audio {...props} />}</div>
    </>
  );
}

export function UnsupportedViewer({ path, onOpenExternally, onCite, handle, children }: { path: string; onOpenExternally(): void; onCite?(): void; handle?: ViewerProps['handle']; children?: React.ReactNode }) {
  const ext = extname(path);
  useEffect(() => {
    handle?.({ citeTarget: () => ({ loc: {} }) });
    return () => handle?.(null);
  }, []);
  // An old Office file: say what it is and how to make it one Locus can show, not just "no preview".
  const old = ext === 'doc' ? { app: 'Word', kind: 'Word document', save: 'Word Document (*.docx)' } : ext === 'ppt' ? { app: 'PowerPoint', kind: 'presentation', save: 'PowerPoint Presentation (*.pptx)' } : null;
  return (
    <>
      <div className="toolbar">
        {children}
        <div className="spacer" />
        {onCite && <CiteButton icon="file" label="Cite file" title="Insert a link to this whole file into the note (Ctrl+Shift+L)" onCite={onCite} />}
      </div>
      <div className="empty">
        {old ? (
          <>
            <h3>This {old.kind} is in the old .{ext} format</h3>
            <div>
              Locus shows and cites inside .{ext}x files. Open this one in {old.app}, choose <b>File → Save As</b>, and save it as <b>{old.save}</b>. You can still link to this file as a whole.
            </div>
          </>
        ) : (
          <>
            <h3>No preview for .{ext} files</h3>
            <div>Locus can't show this kind of file. You can still link to it as a whole, and open it in its usual app.</div>
          </>
        )}
        <button className="outline" onClick={onOpenExternally}><Icon name="external" /> Open in default app</button>
      </div>
    </>
  );
}
