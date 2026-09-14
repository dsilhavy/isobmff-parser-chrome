import type { Segment } from '../capture';
import type { Lane, Span } from '../continuity';
import { groupDigits, issuesOf, rulerStep, stripCommonPrefix, type Issue, type IssueKind } from '../timeline-model';
import { basename, chip, clock, el } from './util';

export type SelectSegment = (segment: Segment, openTfdt?: boolean) => void;

interface View {
  lanes: Lane[];
  timed: Lane[];
  min: number; // shared range, seconds
  max: number;
  visMin: number;
  visSpan: number;
  step: number;
  issues: Issue[];
  selected: Segment | null;
  onSelect: SelectSegment;
  container: HTMLElement;
  summary: HTMLElement;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 200;
const HOVER_DELAY = 150;
const LABEL_MIN_GAP = 44; // px between issue labels before the smaller one hides

// ponytail: module-level state; the panel has exactly one timeline
let zoom = 1;
let offset = 0; // seconds from `min` to the left edge of the visible range
let pinned: number | null = null;
let view: View | null = null;
let bound = false;
let hoverTimer = 0;
let card: HTMLElement | null = null;
let dragged = false;

const rate = (ts: number | undefined) => (ts === undefined ? '' : ts % 1000 === 0 ? `${ts / 1000} kHz` : `${ts} Hz`);
const fmtMs = (secs: number, decimals = 0) => {
  const ms = Math.abs(secs) * 1000;
  return `${secs > 0 ? '+' : '−'}${ms.toFixed(ms < 1 ? 1 : decimals)} ms`;
};
const fmtSecs = (s: number, step: number) => s.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0);

const pct = (v: View, t: number) => `${((t - v.visMin) / v.visSpan) * 100}%`;
const width = (v: View, secs: number) => `${(secs / v.visSpan) * 100}%`;
const trackWidth = (v: View) => v.container.querySelector<HTMLElement>('.tl-overlay')?.clientWidth || 600;

/** Estimated seconds of a span with unknown duration: previous span in the lane, else one ruler step. */
function estimateDuration(lane: Lane, i: number, step: number): number {
  const prev = lane.spans[i - 1];
  return prev?.duration !== undefined && lane.timescale ? prev.duration / lane.timescale : step;
}

// ---------- lanes ----------

function laneLabel(lane: Lane, short: string): HTMLElement {
  const label = el('div', 'lane-label');
  label.title = `${lane.template} · track ${lane.trackId}`;
  label.append(chip(lane.handler), el('span', 'lane-name', short), el('span', 'lane-rate', rate(lane.timescale)));
  return label;
}

function renderLane(v: View, lane: Lane, short: string): HTMLElement {
  const row = el('div', 'lane');
  row.appendChild(laneLabel(lane, short));
  const track = el('div', 'track');
  const ts = lane.timescale;
  // untimed lane: own tick range mapped onto the visible width
  const [lmin, lspan] = ts
    ? [v.visMin, v.visSpan]
    : [Math.min(...lane.spans.map((s) => s.start)), Math.max(1, ...lane.spans.map((s) => s.start + (s.duration ?? 0))) - Math.min(...lane.spans.map((s) => s.start))];
  const toSecs = (ticks: number) => (ts ? ticks / ts : ((ticks - lmin) / lspan) * v.visSpan + v.visMin);

  lane.spans.forEach((s, i) => {
    const bar = el('div', 'bar');
    bar.dataset.lane = lane.key;
    bar.dataset.i = String(i);
    if (s.segment === v.selected) bar.classList.add('selected');
    const dur = s.duration === undefined ? estimateDuration(lane, i, v.step) : ts ? s.duration / ts : (s.duration / lspan) * v.visSpan;
    if (s.duration === undefined) bar.classList.add('unknown');
    bar.style.left = pct(v, toSecs(s.start));
    bar.style.width = width(v, dur);
    track.appendChild(bar);
  });
  row.appendChild(track);
  return row;
}

// ---------- ruler / overlay ----------

function renderRuler(v: View): HTMLElement {
  const ruler = el('div', 'ruler');
  ruler.appendChild(el('div', 'ruler-label', v.timed.length ? 'seconds' : 'ticks'));
  const track = el('div', 'ruler-track');
  if (v.timed.length) {
    const first = Math.ceil(v.visMin / v.step - 1e-9);
    const last = Math.floor((v.visMin + v.visSpan) / v.step + 1e-9);
    const labelEvery = (v.step / v.visSpan) * trackWidth(v) >= 60 ? 1 : 2;
    for (let k = first; k <= last; k++) {
      const t = k * v.step;
      const tick = el('div', 'tick');
      const labelled = k % labelEvery === 0;
      tick.style.height = labelled ? '8px' : '4px';
      tick.style.left = pct(v, t);
      track.appendChild(tick);
      if (labelled) {
        const label = el('div', 'tick-label', fmtSecs(t, v.step));
        label.style.left = pct(v, t);
        if ((t - v.visMin) / v.visSpan > 0.94) label.classList.add('last');
        track.appendChild(label);
      }
    }
  }
  const pill = el('div', 'playhead-pill');
  pill.hidden = true;
  track.appendChild(pill);
  ruler.appendChild(track);
  return ruler;
}

function renderOverlay(v: View): HTMLElement {
  const overlay = el('div', 'tl-overlay');
  const line = el('div', 'playhead-line');
  line.hidden = true;
  overlay.appendChild(line);
  for (const issue of v.issues) {
    if (issue.kind === 'unknown' || Number.isNaN(issue.t)) continue;
    const delta = issue.span.deltaBefore! / issue.lane.timescale!;
    const mark = el('div', `tl-marker ${issue.kind}`);
    mark.style.left = pct(v, issue.t);
    mark.style.width = `max(2px, ${width(v, Math.abs(delta))})`;
    const label = el('div', `tl-marker-label ${issue.kind}`, fmtMs(delta));
    label.style.left = pct(v, issue.t);
    label.dataset.key = `${issue.lane.key}/${issue.span.start}`;
    label.dataset.abs = String(Math.abs(delta));
    overlay.append(mark, label);
  }
  return overlay;
}

/** Hide colliding issue labels, keeping the larger |Δ|; needs layout, so runs after mount. */
function resolveLabelCollisions(overlay: HTMLElement): void {
  const labels = [...overlay.querySelectorAll<HTMLElement>('.tl-marker-label')].sort(
    (a, b) => Number(b.dataset.abs) - Number(a.dataset.abs),
  );
  const placed: number[] = [];
  for (const label of labels) {
    const x = label.offsetLeft;
    const collides = placed.some((p) => Math.abs(p - x) < LABEL_MIN_GAP);
    label.classList.toggle('collide', collides);
    if (!collides) placed.push(x);
  }
}

// ---------- summary ----------

function renderSummary(v: View): void {
  const s = v.summary;
  s.replaceChildren();
  s.append(el('span', 'tl-caret'), el('span', 'tl-title', 'Timeline'));
  const range = v.timed.length ? ` · ${fmtSecs(v.min, 1)}–${fmtSecs(v.max, 1)} s` : '';
  s.append(el('span', 'tl-meta', `${v.lanes.length} lane${v.lanes.length === 1 ? '' : 's'}${range}`));

  const chips = el('span', 'tl-chips');
  for (const kind of ['gap', 'overlap', 'unknown'] as IssueKind[]) {
    const n = v.issues.filter((i) => i.kind === kind).length;
    if (!n) continue;
    const chip = el('button', `tl-chip ${kind}`, `${n} ${kind}`);
    chip.dataset.kind = kind;
    chip.title = `Jump to the next ${kind}`;
    chips.appendChild(chip);
  }
  s.appendChild(chips);

  if (v.issues.length) {
    const stepper = el('span', 'tl-stepper');
    const prev = el('button', 'tl-step', '◂');
    prev.dataset.dir = '-1';
    prev.title = 'Previous issue  [';
    const next = el('button', 'tl-step', '▸');
    next.dataset.dir = '1';
    next.title = 'Next issue  ]';
    stepper.append(prev, next, el('span', 'tl-hint', 'step issues'));
    s.appendChild(stepper);
  }

  const right = el('span', 'tl-right');
  const legend = (cls: string, text: string) => {
    const item = el('span', 'tl-legend');
    item.append(el('span', `swatch ${cls}`), text);
    return item;
  };
  right.append(legend('segment', 'segment'), legend('gap', 'gap'), legend('overlap', 'overlap'), legend('unknown', 'unknown dur'));
  right.appendChild(el('span', 'tl-scale'));
  s.appendChild(right);
}

// ---------- hover card ----------

function hideCard(): void {
  clearTimeout(hoverTimer);
  card?.remove();
  card = null;
  view?.container.querySelector('.hover-cursor')?.remove();
  view?.container.querySelectorAll('.tl-marker-label.show').forEach((l) => l.classList.remove('show'));
}

function buildCard(lane: Lane, span: Span, index: number): HTMLElement {
  const c = el('div', 'hover-card');
  const ts = lane.timescale;
  const secs = (ticks: number) => (ts ? `${(ticks / ts).toFixed(3)} s` : '');
  const head = el('div', 'hc-head', basename(span.segment.url));
  head.appendChild(
    el(
      'span',
      'hc-meta',
      ` · track ${lane.trackId}${lane.handler ? ` · ${lane.handler}` : ''}${ts ? ` · ${ts} Hz` : ''} · ${span.segment.bytes.byteLength.toLocaleString()} B · ${clock(span.segment.time)}`,
    ),
  );
  c.appendChild(head);
  const grid = el('div', 'hc-grid');
  const row = (k: string, a: string, b: string, cls = '') => {
    grid.append(el('span', `hc-key ${cls}`, k), el('span', cls, a), el('span', `hc-ticks ${cls}`, b));
  };
  row('tfdt', secs(span.start), `${groupDigits(span.start)} ticks`);
  if (span.duration === undefined) row('dur', 'duration unknown', '');
  else row('dur', secs(span.duration), `${groupDigits(span.duration)} ticks`);
  const d = span.deltaBefore;
  if (d !== undefined && d !== 0) {
    const prevIndex = index; // spans are 1-based in the label: "after seg N"
    row(d > 0 ? 'gap' : 'overlap', ts ? fmtMs(d / ts, 1) : `${d} ticks`, `${groupDigits(Math.abs(d))} ticks · after seg ${prevIndex}`, d > 0 ? 'gap' : 'overlap');
  }
  c.appendChild(grid);
  c.appendChild(el('div', 'hc-foot', 'click · select segment   ⇧click · select + open tfdt'));
  return c;
}

function showCard(bar: HTMLElement): void {
  if (!view) return;
  const lane = view.lanes.find((l) => l.key === bar.dataset.lane);
  const i = Number(bar.dataset.i);
  const span = lane?.spans[i];
  if (!lane || !span) return;
  hideCard();
  const cursor = el('div', 'hover-cursor');
  cursor.style.left = bar.style.left;
  bar.parentElement!.appendChild(cursor);
  view.container.querySelector(`.tl-marker-label[data-key="${CSS.escape(`${lane.key}/${span.start}`)}"]`)?.classList.add('show');

  card = buildCard(lane, span, i);
  document.body.appendChild(card);
  const r = bar.getBoundingClientRect();
  const trackRect = bar.parentElement!.getBoundingClientRect();
  card.style.bottom = `${window.innerHeight - trackRect.top + 4}px`;
  const w = card.offsetWidth;
  card.style.left = `${r.left + w > window.innerWidth - 4 ? Math.max(0, r.left - w) : r.left}px`;
}

// ---------- playhead / zoom / pan ----------

function overlayX(e: MouseEvent): { x: number; w: number } | null {
  const overlay = view?.container.querySelector<HTMLElement>('.tl-overlay');
  if (!overlay) return null;
  const r = overlay.getBoundingClientRect();
  return { x: e.clientX - r.left, w: r.width };
}

function setPlayhead(t: number | null): void {
  if (!view) return;
  const line = view.container.querySelector<HTMLElement>('.playhead-line');
  const pill = view.container.querySelector<HTMLElement>('.playhead-pill');
  if (!line || !pill) return;
  const show = t !== null && view.timed.length > 0;
  line.hidden = pill.hidden = !show;
  if (!show) return;
  line.style.left = pill.style.left = pct(view, t!);
  pill.textContent = `${t!.toFixed(3)} s`;
}

function clampOffset(v: View): void {
  const span = v.max - v.min;
  offset = Math.min(Math.max(offset, 0), Math.max(0, span - span / zoom));
}

function rerender(): void {
  if (view) renderTimeline(view.container, view.summary, view.lanes, view.selected, view.onSelect);
}

function reveal(t: number): void {
  if (!view || Number.isNaN(t)) return;
  if (t >= view.visMin && t <= view.visMin + view.visSpan) return;
  offset = t - view.visSpan / 2 - view.min;
  clampOffset(view);
}

function jump(list: Issue[], dir: 1 | -1): void {
  if (!view || !list.length) return;
  const idx = list.findIndex((i) => i.span.segment === view!.selected);
  const next = list[idx < 0 ? (dir > 0 ? 0 : list.length - 1) : (idx + dir + list.length) % list.length];
  reveal(next.t);
  view.onSelect(next.span.segment);
}

function bind(container: HTMLElement, summary: HTMLElement): void {
  if (bound) return;
  bound = true;
  const pane = container.parentElement!;

  summary.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const chip = t.closest<HTMLElement>('.tl-chip');
    const step = t.closest<HTMLElement>('.tl-step');
    if (!chip && !step) return;
    e.preventDefault(); // don't toggle <details>
    if (!view) return;
    if (chip) jump(view.issues.filter((i) => i.kind === chip.dataset.kind), 1);
    else jump(view.issues, Number(step!.dataset.dir) as 1 | -1);
  });

  pane.addEventListener('keydown', (e) => {
    if (!view || (e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === '[') jump(view.issues, -1);
    else if (e.key === ']') jump(view.issues, 1);
    else return;
    e.preventDefault();
  });

  container.addEventListener('mouseover', (e) => {
    const bar = (e.target as HTMLElement).closest<HTMLElement>('.bar');
    if (!bar) return;
    clearTimeout(hoverTimer);
    hoverTimer = window.setTimeout(() => showCard(bar), HOVER_DELAY);
  });
  container.addEventListener('mouseout', (e) => {
    if ((e.target as HTMLElement).closest('.bar')) hideCard();
  });

  container.addEventListener('mousemove', (e) => {
    if (pinned !== null || !view) return;
    const p = overlayX(e);
    if (p) setPlayhead(view.visMin + (p.x / p.w) * view.visSpan);
  });
  pane.addEventListener('mouseleave', () => {
    if (pinned === null) setPlayhead(null);
    hideCard();
  });

  container.addEventListener('click', (e) => {
    if (dragged || !view) return;
    const t = e.target as HTMLElement;
    const bar = t.closest<HTMLElement>('.bar');
    if (bar) {
      const lane = view.lanes.find((l) => l.key === bar.dataset.lane);
      const span = lane?.spans[Number(bar.dataset.i)];
      if (span) view.onSelect(span.segment, e.shiftKey);
      return;
    }
    if (t.closest('.ruler-track')) {
      const p = overlayX(e);
      if (!p) return;
      pinned = pinned === null ? view.visMin + (p.x / p.w) * view.visSpan : null;
      setPlayhead(pinned ?? view.visMin + (p.x / p.w) * view.visSpan);
      container.classList.toggle('pinned', pinned !== null);
    }
  });

  container.addEventListener(
    'wheel',
    (e) => {
      if (!e.altKey || !view || !view.timed.length) return;
      e.preventDefault();
      const p = overlayX(e);
      if (!p) return;
      const anchor = view.visMin + (p.x / p.w) * view.visSpan;
      zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * Math.exp(-e.deltaY * 0.005)));
      const visSpan = (view.max - view.min) / zoom;
      offset = anchor - (p.x / p.w) * visSpan - view.min;
      clampOffset(view);
      rerender();
    },
    { passive: false },
  );

  let drag: { x: number; offset0: number } | null = null;
  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !view || zoom === 1) return;
    drag = { x: e.clientX, offset0: offset };
    dragged = false;
    container.setPointerCapture(e.pointerId);
  });
  container.addEventListener('pointermove', (e) => {
    if (!drag || !view) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 3) dragged = true;
    if (!dragged) return;
    const p = overlayX(e);
    if (!p) return;
    offset = drag.offset0 - (dx / p.w) * view.visSpan;
    clampOffset(view);
    hideCard();
    rerender();
  });
  const endDrag = () => {
    drag = null;
    setTimeout(() => (dragged = false), 0); // let the trailing click see `dragged`
  };
  container.addEventListener('pointerup', endDrag);
  container.addEventListener('pointercancel', endDrag);

  container.addEventListener('dblclick', () => {
    zoom = 1;
    offset = 0;
    rerender();
  });

  window.addEventListener('resize', rerender);
}

// ---------- entry ----------

export function renderTimeline(
  container: HTMLElement,
  summary: HTMLElement,
  lanes: Lane[],
  selected: Segment | null,
  onSelect: SelectSegment,
): void {
  hideCard();
  const timed = lanes.filter((l) => l.timescale !== undefined);
  const min = timed.length ? Math.min(...timed.map((l) => Math.min(...l.spans.map((s) => s.start)) / l.timescale!)) : 0;
  const max = timed.length
    ? Math.max(min + 1e-3, ...timed.map((l) => Math.max(...l.spans.map((s) => s.start + (s.duration ?? 0))) / l.timescale!))
    : 1;
  const v: View = {
    lanes, timed, min, max, visMin: 0, visSpan: 1, step: 1,
    issues: issuesOf(lanes), selected, onSelect, container, summary,
  };
  clampOffset(v);
  v.visMin = min + offset;
  v.visSpan = (max - min) / zoom;
  const durations = timed.flatMap((l) => l.spans.map((s) => (s.duration ?? NaN) / l.timescale!)).filter((d) => d > 0);
  v.step = rulerStep(durations, v.visSpan, trackWidth(v));
  view = v;

  renderSummary(v);
  const shorts = stripCommonPrefix(lanes.map((l) => l.template));
  const stack = el('div', 'tl-lanes');
  stack.append(...lanes.map((l, i) => renderLane(v, l, shorts[i])), renderRuler(v), renderOverlay(v));
  container.replaceChildren(stack);
  container.classList.toggle('zoomed', zoom > 1);
  bind(container, summary);

  // needs layout
  const overlay = stack.querySelector<HTMLElement>('.tl-overlay')!;
  resolveLabelCollisions(overlay);
  const w = overlay.clientWidth;
  const scale = summary.querySelector('.tl-scale');
  if (scale && timed.length && w) {
    const msPerPx = (v.visSpan * 1000) / w;
    scale.textContent = `1 px = ${msPerPx < 10 ? msPerPx.toFixed(1) : Math.round(msPerPx)} ms · ⌥wheel zoom · drag pan`;
  }
  if (pinned !== null) setPlayhead(pinned);
}
