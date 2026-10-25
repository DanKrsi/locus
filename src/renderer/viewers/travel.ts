// Moving to another place in the same document (UI spec §5.2): the view glides there instead of
// snapping, and a rail at the right edge shows where in the document you were and where you went.
// Honours the system's reduced-motion setting.

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** The same curve for CSS (the rail's dot moves in step with the scroll). */
const EASE_CSS = 'cubic-bezier(0.65, 0, 0.35, 1)';

const running = new WeakMap<HTMLElement, () => void>();

/**
 * Scrolls el to the target with an ease-in-out glide; long jumps take longer but stay quick.
 * A wheel turn or click during the glide stops it. Returns the glide's duration in ms (0 = jumped).
 */
export function glide(el: HTMLElement, to: { top?: number; left?: number }): number {
  running.get(el)?.();
  const fromTop = el.scrollTop;
  const fromLeft = el.scrollLeft;
  const top = Math.max(0, Math.min(to.top ?? fromTop, el.scrollHeight - el.clientHeight));
  const left = Math.max(0, Math.min(to.left ?? fromLeft, el.scrollWidth - el.clientWidth));
  const dist = Math.hypot(top - fromTop, left - fromLeft);
  if (reduced() || dist < 2) {
    el.scrollTop = top;
    el.scrollLeft = left;
    return 0;
  }
  const screens = dist / Math.max(1, el.clientHeight);
  const duration = Math.round(Math.min(820, 280 + 150 * Math.log2(1 + screens)));
  const start = performance.now();
  let stopped = false;
  const stop = () => {
    stopped = true;
    el.removeEventListener('wheel', stop);
    el.removeEventListener('pointerdown', stop);
    running.delete(el);
  };
  el.addEventListener('wheel', stop, { passive: true });
  el.addEventListener('pointerdown', stop);
  running.set(el, stop);
  const step = (now: number) => {
    if (stopped) return;
    const t = Math.min(1, (now - start) / duration);
    const e = easeInOut(t);
    el.scrollTop = fromTop + (top - fromTop) * e;
    el.scrollLeft = fromLeft + (left - fromLeft) * e;
    if (t < 1) requestAnimationFrame(step);
    else stop();
  };
  requestAnimationFrame(step);
  return duration;
}

/**
 * Where to scroll so a cited span [start, end] (content pixels) sits in the middle of the view, the
 * same way every time a link is followed. A span taller than the view starts just below its top edge.
 */
export function centred(size: number, start: number, end: number, margin = 40): number {
  return end - start > size - 2 * margin ? start - margin : (start + end) / 2 - size / 2;
}

/** Whether a viewer has been on screen long enough that moving within it should glide. */
export function settled(el: HTMLElement | null, readySince: number): boolean {
  return !!el && el.clientHeight > 0 && readySince > 0 && performance.now() - readySince > 450;
}

/**
 * Shows the travel rail over host: the document as a slim track, a ring where you were and a dot
 * that slides to where you're going (positions 0–1 through the document), labelled with both.
 */
export function showTravel(host: HTMLElement, from: number, to: number, fromLabel: string, toLabel: string, duration: number) {
  host.querySelector(':scope > .travel-rail')?.remove();
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const pct = (v: number) => `${(Math.max(0, Math.min(1, v)) * 100).toFixed(2)}%`;
  const rail = document.createElement('div');
  rail.className = 'travel-rail';
  rail.setAttribute('aria-hidden', 'true');
  const ring = document.createElement('div');
  ring.className = 'travel-from';
  ring.style.top = pct(from);
  ring.dataset.label = fromLabel;
  const dot = document.createElement('div');
  dot.className = 'travel-dot';
  dot.style.top = pct(from);
  const label = document.createElement('span');
  label.className = 'travel-label';
  label.textContent = toLabel;
  dot.append(label);
  rail.append(ring, dot);
  host.append(rail);
  const moveMs = reduced() ? 0 : Math.max(duration, 260);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      dot.style.transition = moveMs ? `top ${moveMs}ms ${EASE_CSS}` : 'none';
      dot.style.top = pct(to);
    }),
  );
  setTimeout(() => dot.classList.add('arrived'), moveMs);
  setTimeout(() => rail.classList.add('leaving'), moveMs + 900);
  setTimeout(() => rail.remove(), moveMs + 1300);
}
