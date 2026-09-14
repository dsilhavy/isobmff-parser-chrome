import type { Lane, Span } from './continuity';

export type IssueKind = 'gap' | 'overlap' | 'unknown';

export interface Issue {
  lane: Lane;
  span: Span;
  kind: IssueKind;
  /** Position in seconds on the shared ruler (start of the marker); NaN if the lane has no timescale. */
  t: number;
}

const MIN_MODE_PX = 30; // below this the mode step's labels (every 2nd) would collide
const MIN_NICE_PX = 60;

/** Lane templates with their common URL prefix removed (cut at a slash); a lone lane keeps its basename. */
export function stripCommonPrefix(templates: string[]): string[] {
  let prefix = templates[0] ?? '';
  for (const t of templates) {
    let i = 0;
    while (i < prefix.length && i < t.length && prefix[i] === t[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const cut = prefix.lastIndexOf('/') + 1;
  return templates.map((t) => t.slice(cut) || t.slice(t.lastIndexOf('/') + 1));
}

/** Gaps, overlaps and unknown durations across all lanes, in ruler time order; untimed lanes last. */
export function issuesOf(lanes: Lane[]): Issue[] {
  const out: Issue[] = [];
  for (const lane of lanes) {
    const toSecs = (ticks: number) => (lane.timescale === undefined ? NaN : ticks / lane.timescale);
    for (const span of lane.spans) {
      const d = span.deltaBefore;
      if (d !== undefined && d !== 0) {
        out.push({ lane, span, kind: d > 0 ? 'gap' : 'overlap', t: toSecs(Math.min(span.start, span.start - d)) });
      }
      if (span.duration === undefined) out.push({ lane, span, kind: 'unknown', t: toSecs(span.start) });
    }
  }
  return out.sort((a, b) => (Number.isNaN(a.t) ? 1 : 0) - (Number.isNaN(b.t) ? 1 : 0) || a.t - b.t);
}

/** Smallest 1/2/5 × 10^n step in seconds that is at least `minPx` wide. */
function niceStep(visibleSpan: number, widthPx: number, minPx: number): number {
  const minStep = (visibleSpan * minPx) / Math.max(widthPx, 1);
  const mag = 10 ** Math.floor(Math.log10(minStep));
  for (const m of [1, 2, 5, 10]) if (m * mag >= minStep) return m * mag;
  return 10 * mag;
}

/** Ruler step in seconds: most common span duration if it renders wide enough, else a nice step. */
export function rulerStep(durations: number[], visibleSpan: number, widthPx: number): number {
  const counts = new Map<number, number>();
  for (const d of durations) {
    const key = Math.round(d * 1000) / 1000;
    if (key > 0) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let mode = 0;
  let best = 0;
  for (const [d, n] of counts) if (n > best || (n === best && d < mode)) [mode, best] = [d, n];
  if (mode && (mode / visibleSpan) * widthPx >= MIN_MODE_PX) return mode;
  return niceStep(visibleSpan, widthPx, MIN_NICE_PX);
}

/** 1537920 → "1 537 920" (narrow no-break spaces). */
export function groupDigits(n: number): string {
  return Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
