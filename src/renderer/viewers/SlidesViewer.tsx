// PowerPoint viewer: renders every slide in a scrolling list (pptx-preview), cites the slide in view.
import { useEffect, useRef, useState } from 'react';
import { init } from 'pptx-preview';
import JSZip from 'jszip';

/**
 * Two things the deck needs before it can be drawn:
 *
 * - [Content_Types].xml entries for parts that aren't in the file. PowerPoint ignores them, but
 *   pptx-preview stops loading slides when it meets one (some generators emit them).
 * - Pieces PowerPoint wrote twice — equations above all, and modern charts and effects. The
 *   renderer skips those blocks whole, so the slide comes up missing them; putting PowerPoint's
 *   own fallback picture in their place is what the fallback is for (see core/slides).
 */
async function sanitize(data: Uint8Array): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(data);
  let changed = false;
  const types = await zip.file('[Content_Types].xml')?.async('string');
  if (types) {
    const fixed = types.replace(/<Override PartName="\/([^"]+)"[^>]*\/>/g, (m, part: string) => (zip.file(part) ? m : ''));
    if (fixed !== types) {
      zip.file('[Content_Types].xml', fixed);
      changed = true;
    }
  }
  for (const file of zip.file(/^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/)) {
    const xml = await file.async('string');
    const shown = showFallbacks(xml);
    if (shown !== xml) {
      zip.file(file.name, shown);
      changed = true;
    }
  }
  return changed ? zip.generateAsync({ type: 'arraybuffer' }) : (data.slice().buffer as ArrayBuffer);
}
import type { Rect } from '../../core/link';
import { showFallbacks } from '../../core/slides';
import { Icon } from '../icons';
import { CiteButton } from './CiteButton';
import type { ViewerProps } from './types';
import { centred, glide, pulse, settled, showTravel } from './travel';

/** Slide elements produced by pptx-preview, in order. */
function slideElements(root: HTMLElement): HTMLElement[] {
  const wrapper = root.querySelector<HTMLElement>('.pptx-preview-wrapper') ?? root;
  const direct = [...wrapper.querySelectorAll<HTMLElement>('.pptx-preview-slide-wrapper')];
  return direct.length ? direct : ([...wrapper.children] as HTMLElement[]).filter((c) => c.offsetHeight > 50);
}

/** A box on a slide is written in points of a 960 x 540 slide, the way a PDF box is in page points. */
const SLIDE_W = 960;
const SLIDE_H = 540;

/** The words inside a drawn box, so the link can quote them and find the place again. */
function textInBox(slide: HTMLElement, box: { left: number; top: number; right: number; bottom: number }, limit = 400): string {
  const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    if (!text) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const b = range.getBoundingClientRect();
    if (!b.width && !b.height) continue;
    const x = (b.left + b.right) / 2;
    const y = (b.top + b.bottom) / 2;
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) parts.push(text);
  }
  const all = parts.join(' ').replace(/\s+/g, ' ').trim();
  return all.length > limit ? all.slice(0, limit).replace(/\s+\S*$/, '') : all;
}

export function SlidesViewer({ data, reveal, onCite, handle, marks, onMark, onPlace, zoom = 1, children }: ViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [slide, setSlide] = useState(1);
  const [input, setInput] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const slideRef = useRef(1);
  slideRef.current = slide;
  const stageRef = useRef<HTMLDivElement>(null);
  const [areaMode, setAreaMode] = useState(false);
  const [area, setArea] = useState<{ slide: number; rect: Rect } | null>(null);
  const [areaText, setAreaText] = useState<string | null>(null);
  const [cited, setCited] = useState<{ slide: number; rect: Rect } | null>(null);
  /** The box being dragged, in pixels inside the slide it started on. */
  const [drag, setDrag] = useState<{ slide: number; x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** Where the boxes sit on the stage; recomputed whenever the slides are laid out again. */
  const [boxes, setBoxes] = useState<{ key: string; cited?: boolean; style: React.CSSProperties }[]>([]);
  const pending = useRef<number | null>(null);
  /** True while slides are being (re)drawn: scroll events then are layout noise, not the reader. */
  const rendering = useRef(false);

  // Re-render when the pane width settles or changes (pptx-preview renders at a fixed width).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let t: number | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = window.setTimeout(() => el.clientWidth > 0 && setWidth(Math.max(320, Math.floor(el.clientWidth - 48))), 120);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !width) return;
    let cancelled = false;
    // Keep the slide the reader was on (or was sent to) across re-renders.
    const keep = pending.current ?? slideRef.current;
    rendering.current = true;
    host.replaceChildren();
    setError(null);
    const w = Math.round(width * zoom);
    const previewer = init(host, { width: w, height: Math.round((w * 9) / 16), mode: 'list' });
    sanitize(data)
      .then((buf) => previewer.preview(buf))
      .then(() => {
        if (cancelled) return;
        const slides = slideElements(host);
        slides.forEach((s, i) => (s.dataset.slide = String(i + 1)));
        setCount(slides.length);
        requestAnimationFrame(() => {
          goTo(pending.current ?? keep, false);
          rendering.current = false;
          if (!readySince.current && (scrollRef.current?.clientHeight ?? 0) > 0) readySince.current = performance.now();
        });
      })
      .catch((e: unknown) => !cancelled && setError(String((e as Error)?.message ?? e)));
    return () => {
      cancelled = true;
      previewer.destroy?.();
    };
  }, [data, width, zoom]);

  /** When the slides were first shown (0 until then): later jumps glide instead of snapping. */
  const readySince = useRef(0);
  const goTo = (n: number, keepPending = true, animate = false) => {
    const host = hostRef.current;
    const scroller = scrollRef.current;
    if (!host || !scroller) return;
    const slides = slideElements(host);
    if (!slides.length) {
      pending.current = n;
      return;
    }
    if (!keepPending) pending.current = null;
    const to = Math.min(Math.max(1, n), slides.length);
    const target = slides[to - 1];
    // Positions from the screen: slides sit inside pptx-preview's own positioned wrapper.
    const box = target.getBoundingClientRect();
    const start = scroller.scrollTop + box.top - scroller.getBoundingClientRect().top;
    // The slide is centred in the view (one taller than the view starts at its top).
    const top = Math.max(0, centred(scroller.clientHeight, start, start + box.height, 12));
    if (animate && settled(scroller, readySince.current) && !rendering.current) {
      const mid = scroller.clientHeight / 2;
      const ms = glide(scroller, { top });
      // Already there: no travel to show, just a pulse on what is cited.
      if (ms === null) pulse(scroller);
      else showTravel(scroller.parentElement!, (scroller.scrollTop + mid) / scroller.scrollHeight, (top + mid) / scroller.scrollHeight, `slide ${slideRef.current}`, `slide ${to}`, ms);
    } else scroller.scrollTop = top;
    if (!readySince.current && scroller.clientHeight > 0 && !rendering.current) readySince.current = performance.now();
    setSlide(to);
  };

  useEffect(() => {
    if (reveal?.loc.slide) {
      pending.current = reveal.loc.slide;
      setCited(reveal.loc.viewrect ? { slide: reveal.loc.slide, rect: reveal.loc.viewrect } : null);
      setArea(null);
      goTo(reveal.loc.slide, true, !reveal.follow);
    }
  }, [reveal]);

  /** The box under the pointer while it is being drawn, in stage coordinates. */
  const dragStyle = (d: { slide: number; x0: number; y0: number; x1: number; y1: number }): React.CSSProperties | null => {
    const host = hostRef.current;
    const stage = stageRef.current;
    const el = host ? slideElements(host)[d.slide - 1] : null;
    if (!el || !stage) return null;
    const b = el.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    return {
      left: b.left - s.left + Math.min(d.x0, d.x1),
      top: b.top - s.top + Math.min(d.y0, d.y1),
      width: Math.abs(d.x1 - d.x0),
      height: Math.abs(d.y1 - d.y0),
    };
  };

  /** Slide coordinates to a box on the stage: the slides move, the numbers in the link do not. */
  const place = (slide: number, rect: Rect): React.CSSProperties | null => {
    const host = hostRef.current;
    const stage = stageRef.current;
    const el = host ? slideElements(host)[slide - 1] : null;
    if (!el || !stage) return null;
    const b = el.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    if (!b.width || !b.height) return null;
    return {
      left: b.left - s.left + (rect.x / SLIDE_W) * b.width,
      top: b.top - s.top + (rect.y / SLIDE_H) * b.height,
      width: (rect.w / SLIDE_W) * b.width,
      height: (rect.h / SLIDE_H) * b.height,
    };
  };

  useEffect(() => {
    const next: { key: string; cited?: boolean; style: React.CSSProperties }[] = [];
    const drawn = area && place(area.slide, area.rect);
    if (drawn) next.push({ key: 'area', style: drawn });
    const mark = cited && place(cited.slide, cited.rect);
    if (mark) next.push({ key: 'cited', cited: true, style: mark });
    setBoxes(next);
  }, [area, cited, count, width, zoom, slide]);

  // Report the slide in view (keeps the sides of a comparison together).
  useEffect(() => {
    onPlace?.({ slide });
  }, [slide]);

  useEffect(() => setInput(String(slide)), [slide]);

  const onScroll = () => {
    const host = hostRef.current;
    const scroller = scrollRef.current;
    if (!host || !scroller || scroller.clientHeight === 0 || rendering.current) return;
    const mark = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.35;
    let n = 1;
    slideElements(host).forEach((s, i) => {
      if (s.getBoundingClientRect().top <= mark) n = i + 1;
    });
    if (n !== slide) setSlide(n);
  };

  useEffect(() => {
    handle({
      citeTarget: () =>
        count
          ? {
              loc: area ? { slide: area.slide, viewrect: area.rect } : { slide: slideRef.current },
              // A box quotes what it was drawn around, so it can be found again when the deck changes.
              quote: area ? areaText ?? undefined : undefined,
            }
          : null,
    });
    return () => handle(null);
  }, [count, area, areaText]);

  if (error) return <div className="empty"><h3>This presentation couldn't be shown</h3><div>{error}</div></div>;

  const markedSlides = new Map<number, typeof marks>();
  for (const m of marks ?? []) if (m.loc.slide) markedSlides.set(m.loc.slide, [...(markedSlides.get(m.loc.slide) ?? []), m]);

  return (
    <>
      <div className="toolbar">
        {children}
        <button className="icon" title="Previous slide" onClick={() => goTo(slide - 1)}><Icon name="chevLeft" /></button>
        <span className="muted">Slide</span>
        <input
          className="page-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && goTo(parseInt(input, 10) || 1)}
          onFocus={(e) => e.target.select()}
        />
        <span className="muted">of {count || '…'}</span>
        <button className="icon" title="Next slide" onClick={() => goTo(slide + 1)}><Icon name="chevRight" /></button>
        {markedSlides.has(slide) && (
          <button className="icon" title="Notes that cite this slide" onClick={() => onMark?.(markedSlides.get(slide)![0])}>
            <Icon name="bookmark" /> <span style={{ color: 'var(--mark)' }}>cited</span>
          </button>
        )}
        <button
          className={'icon' + (areaMode ? ' active' : '')}
          title="Draw a box on a slide to cite part of it"
          onClick={() => {
            setAreaMode(!areaMode);
            if (!areaMode) setArea(null);
          }}
        >
          <Icon name="area" /> Area
        </button>
        {area && (
          <button className="icon" title="Clear the box" onClick={() => setArea(null)}>
            <Icon name="x" />
          </button>
        )}
        <div className="spacer" />
        <CiteButton
          icon="slides"
          label={area ? 'Cite area' : 'Cite slide'}
          title="Insert a link to this slide into the note (Ctrl+Shift+L)"
          onCite={onCite}
        />
      </div>
      <div className="slides-scroll" ref={scrollRef} onScroll={onScroll}>
        <div
          className={'slides-stage' + (areaMode ? ' area-mode' : '')}
          ref={stageRef}
          onMouseDown={(e) => {
            if (!areaMode || e.button !== 0) return;
            const host = hostRef.current;
            const hit = host
              ? slideElements(host).find((el) => {
                  const b = el.getBoundingClientRect();
                  return e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom;
                })
              : undefined;
            if (!hit) return;
            e.preventDefault();
            const b = hit.getBoundingClientRect();
            const x = e.clientX - b.left;
            const y = e.clientY - b.top;
            setDrag({ slide: Number(hit.dataset.slide) || 1, x0: x, y0: y, x1: x, y1: y });
          }}
          onMouseMove={(e) => {
            if (!drag) return;
            const host = hostRef.current;
            const el = host ? slideElements(host)[drag.slide - 1] : null;
            if (!el) return;
            const b = el.getBoundingClientRect();
            setDrag({ ...drag, x1: Math.min(Math.max(0, e.clientX - b.left), b.width), y1: Math.min(Math.max(0, e.clientY - b.top), b.height) });
          }}
          onMouseUp={() => {
            if (!drag) return;
            const host = hostRef.current;
            const el = host ? slideElements(host)[drag.slide - 1] : null;
            setDrag(null);
            if (!el) return;
            const b = el.getBoundingClientRect();
            const x = Math.min(drag.x0, drag.x1);
            const y = Math.min(drag.y0, drag.y1);
            const w = Math.abs(drag.x1 - drag.x0);
            const h = Math.abs(drag.y1 - drag.y0);
            if (w < 6 || h < 6) return;
            setArea({
              slide: drag.slide,
              rect: {
                x: Math.round((x / b.width) * SLIDE_W),
                y: Math.round((y / b.height) * SLIDE_H),
                w: Math.round((w / b.width) * SLIDE_W),
                h: Math.round((h / b.height) * SLIDE_H),
              },
            });
            setAreaText(textInBox(el, { left: b.left + x, top: b.top + y, right: b.left + x + w, bottom: b.top + y + h }) || null);
            setCited(null);
            setAreaMode(false);
          }}
        >
          <div className="slides-host" ref={hostRef} />
          <div className="slides-boxes">
            {drag && dragStyle(drag) && <div className="area-box" style={dragStyle(drag)!} />}
            {boxes.map((b) => (
              <div key={b.key} className={'area-box' + (b.cited ? ' cited' : '')} style={b.style} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
