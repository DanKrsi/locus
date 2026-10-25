// PowerPoint viewer: renders every slide in a scrolling list (pptx-preview), cites the slide in view.
import { useEffect, useRef, useState } from 'react';
import { init } from 'pptx-preview';
import JSZip from 'jszip';

/**
 * Removes [Content_Types].xml entries for parts that aren't in the file. PowerPoint ignores
 * them, but pptx-preview stops loading slides when it meets one (some generators emit them).
 */
async function sanitize(data: Uint8Array): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(data);
  const types = await zip.file('[Content_Types].xml')?.async('string');
  if (types) {
    const fixed = types.replace(/<Override PartName="\/([^"]+)"[^>]*\/>/g, (m, part: string) => (zip.file(part) ? m : ''));
    if (fixed !== types) {
      zip.file('[Content_Types].xml', fixed);
      return zip.generateAsync({ type: 'arraybuffer' });
    }
  }
  return data.slice().buffer as ArrayBuffer;
}
import { Icon } from '../icons';
import { CiteButton } from './CiteButton';
import type { ViewerProps } from './types';
import { centred, glide, settled, showTravel } from './travel';

/** Slide elements produced by pptx-preview, in order. */
function slideElements(root: HTMLElement): HTMLElement[] {
  const wrapper = root.querySelector<HTMLElement>('.pptx-preview-wrapper') ?? root;
  const direct = [...wrapper.querySelectorAll<HTMLElement>('.pptx-preview-slide-wrapper')];
  return direct.length ? direct : ([...wrapper.children] as HTMLElement[]).filter((c) => c.offsetHeight > 50);
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
      showTravel(scroller.parentElement!, (scroller.scrollTop + mid) / scroller.scrollHeight, (top + mid) / scroller.scrollHeight, `slide ${slideRef.current}`, `slide ${to}`, ms);
    } else scroller.scrollTop = top;
    if (!readySince.current && scroller.clientHeight > 0 && !rendering.current) readySince.current = performance.now();
    setSlide(to);
  };

  useEffect(() => {
    if (reveal?.loc.slide) {
      pending.current = reveal.loc.slide;
      goTo(reveal.loc.slide, true, !reveal.follow);
    }
  }, [reveal]);

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
    handle({ citeTarget: () => (count ? { loc: { slide: slideRef.current } } : null) });
    return () => handle(null);
  }, [count]);

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
        <div className="spacer" />
        <CiteButton icon="slides" label="Cite slide" title="Insert a link to this slide into the note (Ctrl+Shift+L)" onCite={onCite} />
      </div>
      <div className="slides-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="slides-host" ref={hostRef} />
      </div>
    </>
  );
}
