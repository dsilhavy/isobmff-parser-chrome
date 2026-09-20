import type { EventMessageBox } from '@svta/cml-iso-bmff';
import type { Segment } from './capture';
import type { Lane, Span } from './continuity';

export type IssueKind = 'gap' | 'overlap' | 'unknown' | 'nosync';

export interface Issue {
  lane: Lane;
  span: Span;
  kind: IssueKind;
  /** Position in seconds on the shared ruler (start of the marker); NaN if the lane has no timescale. */
  t: number;
  /** Gap (>0) / overlap (<0) size in ticks; undefined for other kinds. */
  delta?: number;
}

export interface Event {
  segment: Segment;
  box: EventMessageBox;
  t: number; // seconds on the shared ruler; NaN if unresolvable
  label: string; // last piece of schemeIdUri
}

export const AV_WARN_SECS = 0.1;

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

/** Gaps, overlaps, unknown durations and video spans not starting on a sync sample, in ruler time order; untimed lanes last. */
export function issuesOf(lanes: Lane[]): Issue[] {
  const out: Issue[] = [];
  for (const lane of lanes) {
    const toSecs = (ticks: number) => (lane.timescale === undefined ? NaN : ticks / lane.timescale);
    const gap = (span: Span, start: number, delta: number) =>
      out.push({ lane, span, kind: delta > 0 ? 'gap' : 'overlap', t: toSecs(Math.min(start, start - delta)), delta });
    for (const span of lane.spans) {
      const d = span.deltaBefore;
      if (d !== undefined && d !== 0) gap(span, span.start, d);
      for (let i = 1; i < (span.chunks?.length ?? 0); i++) {
        const prev = span.chunks![i - 1];
        const cur = span.chunks![i];
        if (prev.duration === undefined) continue;
        const cd = cur.start - (prev.start + prev.duration);
        if (cd !== 0) gap(span, cur.start, cd);
      }
      if (span.duration === undefined) out.push({ lane, span, kind: 'unknown', t: toSecs(span.start) });
      if (lane.handler === 'vide' && span.syncOffsets && span.syncOffsets[0] !== 0) out.push({ lane, span, kind: 'nosync', t: toSecs(span.start) });
    }
  }
  return out.sort((a, b) => (Number.isNaN(a.t) ? 1 : 0) - (Number.isNaN(b.t) ? 1 : 0) || a.t - b.t);
}

const firstStart = (lanes: Lane[], handler: string): number | undefined => {
  const starts = lanes
    .filter((l) => l.handler === handler && l.timescale && l.spans.length)
    .map((l) => Math.min(...l.spans.map((s) => s.start)) / l.timescale!);
  return starts.length ? Math.min(...starts) : undefined;
};

/** First video start minus first audio start, seconds; undefined without a timed lane of each. */
// ponytail: ignores elst media time; add edit-list correction when a stream with a non-zero offset shows up
export function avOffset(lanes: Lane[]): number | undefined {
  const v = firstStart(lanes, 'vide');
  const a = firstStart(lanes, 'soun');
  return v === undefined || a === undefined ? undefined : Math.round((v - a) * 1e6) / 1e6;
}

const emsgs = (boxes: unknown[]): EventMessageBox[] => boxes.filter((b): b is EventMessageBox => (b as { type?: string }).type === 'emsg');

/** emsg boxes of all segments placed on the ruler: v1 by presentationTime, v0 relative to the segment's first timed span. */
export function eventsOf(segments: Segment[], lanes: Lane[]): Event[] {
  const out: Event[] = [];
  for (const segment of segments) {
    for (const box of emsgs(segment.boxes)) {
      let t: number;
      if (box.version === 1) t = box.presentationTime / box.timescale;
      else {
        const lane = lanes.find((l) => l.timescale && l.spans.some((s) => s.segment === segment));
        const span = lane?.spans.find((s) => s.segment === segment);
        t = lane && span ? span.start / lane.timescale! + box.presentationTimeDelta / box.timescale : NaN;
      }
      out.push({ segment, box, t, label: box.schemeIdUri.split(/[:/]/).filter(Boolean).pop() ?? box.schemeIdUri });
    }
  }
  return out;
}

const NTP_EPOCH_OFFSET = 2208988800; // seconds between 1900-01-01 and 1970-01-01

export function ntpToDate(sec: number, frac: number): Date {
  return new Date((sec - NTP_EPOCH_OFFSET) * 1000 + (frac / 2 ** 32) * 1000);
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
