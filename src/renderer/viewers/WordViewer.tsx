// Word viewer: draws the document page by page (docx-preview) and cites paragraphs. Selecting text
// cites the paragraphs it runs through and quotes it; with nothing selected, the paragraph being
// read is cited, quoting its first words. Links land on their paragraphs, highlighted.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { CiteButton } from './CiteButton';
import type { CiteMark, ViewerProps } from './types';
import { centred, glide, pulse, settled, showTravel } from './travel';
import { drawWord, openingWords, paragraphAt, paragraphsBox, type DrawnWord } from './word';

type Range = { start: number; end: number };

export function WordViewer({ data, reveal, onCite, handle, marks, onMark, onPlace, zoom = 1, children }: ViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [word, setWord] = useState<DrawnWord | null>(null);
  const wordRef = useRef<DrawnWord | null>(null);
  wordRef.current = word;
  const [error, setError] = useState<string | null>(null);
  const [fit, setFit] = useState(1);
  const [page, setPage] = useState(1);
  const [cited, setCited] = useState<Range | null>(null);
  /** Where "Cited in" markers sit on the stage; worked out again whenever the layout changes. */
  const [flags, setFlags] = useState<{ top: number; left: number; marks: CiteMark[] }[]>([]);
  /** A place asked for before the document was drawn. */
  const pending = useRef<{ range: Range; follow?: boolean; draw?: boolean } | null>(null);
  const readySince = useRef(0);
  const scale = fit * zoom;

  useEffect(() => {
    const host = hostRef.current;
    const styles = styleRef.current;
    if (!host || !styles) return;
    let cancelled = false;
    host.replaceChildren();
    styles.replaceChildren();
    setError(null);
    setWord(null);
    readySince.current = 0;
    drawWord(data, host, styles)
      .then((w) => {
        if (cancelled) return;
        setWord(w);
      })
      .catch((e: unknown) => !cancelled && setError(String((e as Error)?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [data]);

  // Pages are drawn at their real size; a pane narrower than a page shows it smaller, and the zoom
  // control scales from there.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !word) return;
    const measure = () => {
      const pageW = word.pages[0]?.offsetWidth ?? 0;
      if (pageW && el.clientWidth) setFit(Math.min(1, (el.clientWidth - 40) / pageW));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [word]);

  useLayoutEffect(() => {
    if (hostRef.current) hostRef.current.style.zoom = String(scale);
  }, [scale]);

  // The cited paragraphs are highlighted on the elements themselves, so they follow every layout.
  useEffect(() => {
    if (!word || !cited) return;
    const els: HTMLElement[] = [];
    for (let n = cited.start; n <= cited.end; n++) els.push(...(word.elements[n - 1] ?? []));
    els.forEach((el, i) => {
      el.classList.add('word-cited');
      if (i === 0) el.classList.add('first');
      if (i === els.length - 1) el.classList.add('last');
    });
    return () => els.forEach((el) => el.classList.remove('word-cited', 'first', 'last'));
  }, [word, cited]);

  /** Scroll position that centres paragraphs start..end. */
  const targetTop = (range: Range): number | null => {
    const scroller = scrollRef.current;
    const w = wordRef.current;
    if (!scroller || !w) return null;
    const box = paragraphsBox(w, range.start, range.end);
    if (!box) return null;
    const top = scroller.scrollTop + box.top - scroller.getBoundingClientRect().top;
    return Math.max(0, centred(scroller.clientHeight, top, top + box.height));
  };

  const selectParagraphs = (range: Range) => {
    const w = wordRef.current;
    const first = w?.elements[range.start - 1]?.[0];
    const lastEls = w?.elements[range.end - 1];
    const last = lastEls?.[lastEls.length - 1];
    if (!first || !last) return;
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStartBefore(first.firstChild ?? first);
    r.setEndAfter(last.lastChild ?? last);
    sel?.removeAllRanges();
    sel?.addRange(r);
  };

  const go = (want: { range: Range; follow?: boolean; draw?: boolean }, animate: boolean) => {
    const scroller = scrollRef.current;
    const w = wordRef.current;
    if (!scroller || !w || !scroller.clientHeight) {
      pending.current = want;
      return;
    }
    const range = { start: Math.min(Math.max(1, want.range.start), w.paragraphs.length), end: Math.min(Math.max(want.range.start, want.range.end), w.paragraphs.length) };
    if (!want.follow) setCited(want.draw ? null : range);
    if (want.draw) selectParagraphs(range);
    const top = targetTop(range);
    if (top === null) return;
    if (animate && settled(scroller, readySince.current)) {
      const mid = scroller.clientHeight / 2;
      const ms = glide(scroller, { top });
      if (ms === null) pulse(scroller);
      else showTravel(scroller.parentElement!, (scroller.scrollTop + mid) / scroller.scrollHeight, (top + mid) / scroller.scrollHeight, `p ${page}`, `para ${range.start}`, ms);
    } else scroller.scrollTop = top;
  };

  useEffect(() => {
    const para = reveal?.loc.para;
    if (!para) return;
    const want = { range: para, follow: reveal.follow, draw: reveal.draw };
    if (!wordRef.current) pending.current = want;
    else go(want, !reveal.follow);
  }, [reveal]);

  // Once drawn and laid out at its size: go where a link asked, then start reporting the place.
  useLayoutEffect(() => {
    if (!word) return;
    const want = pending.current;
    pending.current = null;
    if (want) go(want, false);
    const scroller = scrollRef.current;
    if (scroller && scroller.clientHeight > 0 && !readySince.current) readySince.current = performance.now();
  }, [word, fit]);

  const placeFlags = () => {
    const w = wordRef.current;
    const stage = stageRef.current;
    if (!w || !stage || !marks?.length) return setFlags([]);
    const s = stage.getBoundingClientRect();
    const byTop = new Map<number, { top: number; left: number; marks: CiteMark[] }>();
    for (const m of marks) {
      if (!m.loc.para) continue;
      const box = paragraphsBox(w, m.loc.para.start, m.loc.para.start);
      if (!box) continue;
      const pageEl = w.elements[m.loc.para.start - 1]?.[0]?.closest('section.docx');
      const right = pageEl ? pageEl.getBoundingClientRect().right : box.right;
      const top = Math.round(box.top - s.top);
      const at = byTop.get(top);
      if (at) at.marks.push(m);
      else byTop.set(top, { top, left: right - s.left + 4, marks: [m] });
    }
    setFlags([...byTop.values()]);
  };
  useEffect(placeFlags, [word, marks, scale]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => placeFlags());
    ro.observe(stage);
    return () => ro.disconnect();
  }, [word, marks]);

  /** The paragraph being read: the first with words whose bottom is below a line a third down the view. */
  const paragraphInView = (): number | null => {
    const w = wordRef.current;
    const scroller = scrollRef.current;
    if (!w || !scroller) return null;
    const line = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.3;
    let fallback: number | null = null;
    for (let i = 0; i < w.elements.length; i++) {
      const el = w.elements[i][0];
      if (!el || !w.paragraphs[i].text.trim()) continue;
      const b = el.getBoundingClientRect();
      if (b.bottom >= line) return i + 1;
      fallback = i + 1;
    }
    return fallback;
  };

  const placeTimer = useRef<number | undefined>(undefined);
  const onScroll = () => {
    const w = wordRef.current;
    const scroller = scrollRef.current;
    if (!w || !scroller || !scroller.clientHeight) return;
    const mark = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.3;
    let p = 1;
    w.pages.forEach((el, i) => {
      if (el.getBoundingClientRect().top <= mark) p = i + 1;
    });
    if (p !== page) setPage(p);
    if (onPlace) {
      clearTimeout(placeTimer.current);
      placeTimer.current = window.setTimeout(() => {
        const n = paragraphInView();
        if (n) onPlace({ para: { start: n, end: n } });
      }, 120);
    }
  };

  const selection = (): { range: Range; quote: string } | null => {
    const w = wordRef.current;
    const sel = window.getSelection();
    if (!w || !sel || sel.isCollapsed || !hostRef.current?.contains(sel.anchorNode)) return null;
    const r = sel.getRangeAt(0);
    let a = paragraphAt(w, r.startContainer);
    let b = paragraphAt(w, r.endContainer);
    // A selection that starts or ends between paragraphs (a table's edge) takes the paragraphs inside it.
    if (!a || !b) {
      const inside = [...w.numberOf.entries()].filter(([el]) => r.intersectsNode(el)).map(([, n]) => n);
      if (!inside.length) return null;
      a = a ?? Math.min(...inside);
      b = b ?? Math.max(...inside);
    }
    const quote = sel.toString().replace(/\s+/g, ' ').trim();
    if (!quote) return null;
    return { range: { start: Math.min(a, b), end: Math.max(a, b) }, quote };
  };

  useEffect(() => {
    handle({
      citeTarget: () => {
        const w = wordRef.current;
        if (!w) return null;
        const s = selection();
        if (s) return { loc: { para: s.range }, quote: s.quote };
        const n = paragraphInView();
        if (!n) return { loc: {} };
        return { loc: { para: { start: n, end: n } }, quote: openingWords(w.paragraphs[n - 1].text) || undefined };
      },
    });
    return () => handle(null);
  }, [word]);

  // Links inside the document: web addresses open in the browser, a link to a place in the
  // document scrolls there, and nothing navigates the app away.
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^https?:/i.test(href)) window.open(href);
    else if (href.startsWith('#') && href.length > 1) {
      const target = hostRef.current?.querySelector(`[id="${CSS.escape(href.slice(1))}"], a[name="${CSS.escape(href.slice(1))}"]`);
      const scroller = scrollRef.current;
      if (target && scroller) glide(scroller, { top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40 });
    }
  };

  if (error) return <div className="empty"><h3>This document couldn't be shown</h3><div>{error}</div></div>;

  const markedHere = flags.length > 0;
  return (
    <>
      <div className="toolbar">
        {children}
        <span className="muted">Page {word ? `${page} of ${word.pages.length}` : '…'}</span>
        {markedHere && <span className="muted" title="Paragraphs other notes cite have a bookmark beside them"><Icon name="bookmark" size={13} /> cited</span>}
        <div className="spacer" />
        <CiteButton
          icon="doc"
          label="Cite"
          title="Insert a link to the selected text, or to the paragraph you are reading, into the note (Ctrl+Shift+L)"
          onCite={onCite}
          embed={{ label: 'Insert picture', icon: 'image', title: 'Show a picture of the selected paragraphs (or the one you are reading) in the note' }}
        />
      </div>
      <div className="word-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="word-stage" ref={stageRef}>
          <div className="word-styles" ref={styleRef} />
          <div className="word-host" ref={hostRef} onClick={onClick} />
          {flags.map((f) => (
            <div
              key={f.top}
              className="cite-marker word-flag"
              style={{ top: f.top, left: f.left }}
              title={f.marks.map((m) => `Cited in ${m.note.slice(1)}: ${m.label}`).join('\n')}
              onMouseDown={(e) => {
                e.stopPropagation();
                onMark?.(f.marks[0]);
              }}
            >
              <Icon name="bookmark" size={15} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
