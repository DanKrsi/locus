import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type { Rect } from '../../core/link';
import { Icon } from '../icons';
import { CiteButton } from './CiteButton';
import { openPdf, pdfjs } from './pdf';
import { glide, settled, showTravel } from './travel';
import type { CiteMark, ViewerProps } from './types';

interface Size {
  w: number;
  h: number;
}

const GAP = 14;
const PAD = 16;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function PdfViewer({ data, reveal, onCite, handle, marks, onMark, onPlace, children }: ViewerProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [labels, setLabels] = useState<string[] | null>(null);
  const [fit, setFit] = useState<'width' | 'page' | null>('width');
  const [scale, setScale] = useState(1);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [areaMode, setAreaMode] = useState(false);
  const [area, setArea] = useState<{ page: number; rect: Rect } | null>(null);
  const [cited, setCited] = useState<{ page: number; rect?: Rect } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<{ page: number; y?: number; until: number } | null>(null);
  /** When the pages were first laid out on screen (0 until then): later jumps glide. */
  const readySince = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(null);
    openPdf(data)
      .then(async (d) => {
        if (cancelled) return;
        const first = (await d.getPage(1)).getViewport({ scale: 1 });
        setSizes(Array.from({ length: d.numPages }, () => ({ w: first.width, h: first.height })));
        setLabels(await d.getPageLabels().catch(() => null));
        setDoc(d);
      })
      .catch((e) => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [data]);

  // Fit to width / page when the pane resizes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !sizes.length || !fit) return;
    const apply = () => {
      if (el.clientWidth === 0) return; // hidden tab
      const s = sizes[Math.max(0, page - 1)] ?? sizes[0];
      const byWidth = (el.clientWidth - PAD * 2 - 4) / s.w;
      const byPage = (el.clientHeight - PAD * 2) / s.h;
      setScale(Math.max(0.2, fit === 'width' ? byWidth : Math.min(byWidth, byPage)));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, sizes, doc]);

  const offsets = useMemo(() => {
    const out: number[] = [];
    let y = PAD;
    for (const s of sizes) {
      out.push(y);
      y += s.h * scale + GAP;
    }
    return out;
  }, [sizes, scale]);

  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const pageRef = useRef(page);
  pageRef.current = page;

  const targetTop = (p: number, y?: number) => {
    const offs = offsetsRef.current;
    const idx = Math.min(Math.max(1, p), offs.length) - 1;
    return offs[idx] + (y !== undefined ? Math.max(0, y * scaleRef.current - 60) : -8);
  };
  const applyScroll = (p: number, y?: number) => {
    const el = scrollRef.current;
    if (!el || !offsetsRef.current.length || el.clientHeight === 0) return;
    el.scrollTop = targetTop(p, y);
  };

  // Hidden tabs lose their scroll position; restore the page when shown again.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let hidden = el.clientWidth === 0;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === 0) hidden = true;
      else if (hidden) {
        hidden = false;
        const pending = pendingScroll.current;
        if (pending && Date.now() < pending.until) applyScroll(pending.page, pending.y);
        else applyScroll(pageRef.current);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A jump stays "pending" briefly so layout changes right after it (fit-to-width, page
  // sizes arriving) re-apply it instead of losing it.
  const scrollToPage = (p: number, y?: number) => {
    pendingScroll.current = { page: p, y, until: Date.now() + 1500 };
    applyScroll(p, y);
  };

  useLayoutEffect(() => {
    const pending = pendingScroll.current;
    if (pending && Date.now() < pending.until) applyScroll(pending.page, pending.y);
    else if (doc && offsets.length) applyScroll(page);
    if (doc && offsets.length && !readySince.current && (scrollRef.current?.clientHeight ?? 0) > 0) readySince.current = performance.now();
  }, [offsets]);
  useEffect(() => {
    readySince.current = 0;
  }, [doc]);

  useEffect(() => {
    if (!reveal || !doc) return;
    const { loc } = reveal;
    if (loc.page && reveal.follow) {
      // Keeping the sides of a comparison together: the same page and position, nothing marked.
      scrollToPage(loc.page, loc.viewrect?.y);
    } else if (loc.page) {
      setCited({ page: loc.page, rect: loc.viewrect });
      setArea(null);
      const el = scrollRef.current;
      if (el && settled(el, readySince.current) && offsetsRef.current.length) {
        // Already reading this PDF: glide to the new place and show where it is.
        pendingScroll.current = null;
        const to = targetTop(loc.page, loc.viewrect?.y);
        const mid = el.clientHeight / 2;
        const name = (n: number) => `p ${labels?.[n - 1] ?? n}`;
        const ms = glide(el, { top: to });
        showTravel(el.parentElement!, (el.scrollTop + mid) / el.scrollHeight, (to + mid) / el.scrollHeight, name(pageRef.current), name(loc.page), ms);
      } else scrollToPage(loc.page, loc.viewrect?.y);
    }
  }, [reveal, doc]);

  useEffect(() => setPageInput(labels?.[page - 1] ?? String(page)), [page, labels]);

  const placeTimer = useRef<number | undefined>(undefined);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || el.clientHeight === 0) return;
    if (onPlace) {
      clearTimeout(placeTimer.current);
      placeTimer.current = window.setTimeout(() => {
        // The page at the top of the view, and how far down it is (in the units links use).
        const offs = offsetsRef.current;
        let i = 0;
        while (i + 1 < offs.length && offs[i + 1] <= el.scrollTop) i++;
        const y = Math.max(0, (el.scrollTop - offs[i] + 60) / scaleRef.current);
        onPlace({ page: i + 1, viewrect: { x: 0, y: Math.round(y), w: 0, h: 0 } });
      }, 120);
    }
    const mark = el.scrollTop + el.clientHeight * 0.3;
    let p = 1;
    for (let i = 0; i < offsets.length; i++) if (offsets[i] <= mark) p = i + 1;
    if (p !== page) setPage(p);
  };

  const goToInput = () => {
    const v = pageInput.trim();
    let target: number | undefined;
    if (v.startsWith('#')) target = parseInt(v.slice(1), 10);
    else if (labels) {
      const i = labels.indexOf(v);
      if (i >= 0) target = i + 1;
    }
    if (target === undefined && /^\d+$/.test(v)) target = parseInt(v, 10);
    if (target && doc) scrollToPage(Math.min(target, doc.numPages));
  };

  const zoom = (dir: 1 | -1 | 0) => {
    const next = dir === 0 ? 1 : dir > 0 ? ZOOMS.find((z) => z > scale + 0.01) : [...ZOOMS].reverse().find((z) => z < scale - 0.01);
    if (next) {
      setFit(null);
      setScale(next);
    }
  };
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const selectionQuote = (): { text: string; page?: number } | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !scrollRef.current?.contains(sel.anchorNode)) return null;
    const pageEl = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest('[data-page]');
    return { text: sel.toString(), page: pageEl ? Number(pageEl.getAttribute('data-page')) : undefined };
  };

  useEffect(() => {
    handle({
      zoom: (dir) => zoomRef.current(dir),
      citeTarget: () => {
        if (!doc) return null;
        const q = selectionQuote();
        const p = area?.page ?? q?.page ?? page;
        return {
          loc: area ? { page: area.page, viewrect: area.rect } : { page: p },
          quote: q?.text,
          pageLabel: labels?.[p - 1] && labels[p - 1] !== String(p) ? labels[p - 1] : undefined,
        };
      },
    });
    return () => handle(null);
  }, [doc, area, page, labels]);

  useEffect(() => {
    if (!areaMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAreaMode(false);
        setArea(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [areaMode]);

  if (error) return <div className="empty"><h3>This PDF couldn't be opened</h3><div>{error}</div></div>;

  return (
    <>
      <div className="toolbar">
        {children}
        <button className="icon" title="Previous page" onClick={() => scrollToPage(page - 1)}><Icon name="chevLeft" /></button>
        <input
          className="page-input"
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && goToInput()}
          onFocus={(e) => e.target.select()}
          title="Type a printed page (66) or a file page (#82)"
        />
        <span className="muted">of {doc?.numPages ?? '…'}</span>
        <button className="icon" title="Next page" onClick={() => scrollToPage(page + 1)}><Icon name="chevRight" /></button>
        <div className="sep" />
        <button className="icon" title="Zoom out" onClick={() => zoom(-1)}><Icon name="zoomOut" /></button>
        <select
          value={fit ?? String(scale)}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'width' || v === 'page') setFit(v);
            else {
              setFit(null);
              setScale(Number(v));
            }
          }}
        >
          <option value="width">Fit width</option>
          <option value="page">Fit page</option>
          {ZOOMS.map((z) => <option key={z} value={String(z)}>{Math.round(z * 100)}%</option>)}
          {!fit && !ZOOMS.includes(scale) && <option value={String(scale)}>{Math.round(scale * 100)}%</option>}
        </select>
        <button className="icon" title="Zoom in" onClick={() => zoom(1)}><Icon name="zoomIn" /></button>
        <div className="sep" />
        <button
          className={'icon' + (areaMode ? ' active' : '')}
          title="Highlight an area (drag a box over a figure or table)"
          onClick={() => setAreaMode(!areaMode)}
        >
          <Icon name="area" /> Area
        </button>
        {area && <button className="icon" title="Clear the box" onClick={() => setArea(null)}><Icon name="x" /></button>}
        <div className="spacer" />
        <CiteButton icon="pdf" label={area ? 'Cite area' : 'Cite page'} onCite={onCite} />
      </div>
      <div className="pdf-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="pdf-pages">
          {doc &&
            sizes.map((s, i) => (
              <PdfPage
                key={i}
                doc={doc}
                index={i + 1}
                size={s}
                scale={scale}
                onSize={(size) =>
                  setSizes((prev) => (prev[i].w === size.w && prev[i].h === size.h ? prev : prev.map((p, j) => (j === i ? size : p))))
                }
                areaMode={areaMode}
                area={area?.page === i + 1 ? area.rect : undefined}
                cited={cited?.page === i + 1 ? cited.rect ?? 'page' : undefined}
                marks={marks?.filter((m) => m.loc.page === i + 1)}
                onMark={onMark}
                onArea={(rect) => {
                  setArea({ page: i + 1, rect });
                  setCited(null);
                  setAreaMode(false);
                }}
              />
            ))}
        </div>
      </div>
    </>
  );
}

interface PageProps {
  doc: PDFDocumentProxy;
  index: number;
  size: Size;
  scale: number;
  onSize(s: Size): void;
  areaMode: boolean;
  area?: Rect;
  cited?: Rect | 'page';
  onArea(r: Rect): void;
  marks?: CiteMark[];
  onMark?(m: CiteMark): void;
}

function PdfPage({ doc, index, size, scale, onSize, areaMode, area, cited, onArea, marks, onMark }: PageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const pageRef = useRef<PDFPageProxy | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    (async () => {
      const page = pageRef.current ?? (await doc.getPage(index));
      pageRef.current = page;
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      if (Math.abs(base.width - size.w) > 0.5 || Math.abs(base.height - size.h) > 0.5) onSize({ w: base.width, h: base.height });
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const canvas = canvasRef.current!;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      task = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      await task.promise.catch(() => undefined);
      if (cancelled) return;
      const text = textRef.current!;
      text.replaceChildren();
      const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
      await layer.render().catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, scale, doc, index]);

  const toPage = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const boxStyle = (r: Rect) => ({ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale });

  return (
    <div
      ref={ref}
      data-page={index}
      className={'pdf-page' + (areaMode ? ' area-mode' : '')}
      style={{ width: size.w * scale, height: size.h * scale, ['--scale-factor' as string]: scale, ['--total-scale-factor' as string]: scale }}
      onMouseDown={(e) => {
        if (!areaMode || e.button !== 0) return;
        e.preventDefault();
        const p = toPage(e);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onMouseMove={(e) => {
        if (!drag) return;
        const p = toPage(e);
        setDrag({ ...drag, x1: p.x, y1: p.y });
      }}
      onMouseUp={() => {
        if (!drag) return;
        const rect = { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
        setDrag(null);
        if (rect.w > 4 && rect.h > 4) onArea(rect);
      }}
    >
      <canvas ref={canvasRef} />
      <div className="textLayer" ref={textRef} />
      {drag && <div className="area-box" style={boxStyle({ x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) })} />}
      {area && <div className="area-box" style={boxStyle(area)} />}
      {cited && cited !== 'page' && <div className="area-box cited" style={boxStyle(cited)} />}
      {cited === 'page' && <div className="area-box cited" style={{ inset: 0, background: 'transparent', borderWidth: 3 }} />}
      {marks?.map((m, i) => (
        <div key={i}>
          {m.loc.viewrect && <div className="cite-outline" style={boxStyle(m.loc.viewrect)} />}
          <div
            className="cite-marker"
            style={{ right: 6, top: (m.loc.viewrect ? m.loc.viewrect.y * scale : 6) + i * 2 }}
            title={`Cited in ${m.note.slice(1)}: ${m.label}`}
            onMouseDown={(e) => {
              e.stopPropagation();
              onMark?.(m);
            }}
          >
            <Icon name="bookmark" size={15} />
          </div>
        </div>
      ))}
    </div>
  );
}
