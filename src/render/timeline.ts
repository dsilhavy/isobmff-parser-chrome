import type { Segment } from '../capture';
import type { Lane, Span } from '../continuity';

const basename = (url: string) => url.split('/').pop()?.split('?')[0] || url;
const secs = (ticks: number, timescale: number) => `${(ticks / timescale).toFixed(3)} s`;
const ms = (ticks: number, timescale: number) => `${((ticks / timescale) * 1000).toFixed(1)} ms`;

function fmt(ticks: number, timescale: number | undefined, unit: 'secs' | 'ms'): string {
  if (timescale === undefined) return `${ticks} ticks`;
  return `${(unit === 'secs' ? secs : ms)(ticks, timescale)} (${ticks} ticks)`;
}

function tooltip(span: Span, lane: Lane): string {
  const lines = [basename(span.segment.url), `tfdt ${fmt(span.start, lane.timescale, 'secs')}`];
  lines.push(span.duration === undefined ? 'duration unknown' : `dur ${fmt(span.duration, lane.timescale, 'secs')}`);
  const d = span.deltaBefore;
  if (d !== undefined && d !== 0) {
    const sign = d > 0 ? '+' : '-';
    lines.push(`${d > 0 ? 'gap' : 'overlap'} ${sign}${fmt(Math.abs(d), lane.timescale, 'ms')}`);
  }
  return lines.join('\n');
}

function laneLabel(lane: Lane): HTMLElement {
  const label = document.createElement('div');
  label.className = 'lane-label';
  label.title = lane.template;
  const name = document.createElement('div');
  name.textContent = basename(lane.template);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = [
    `track ${lane.trackId}`,
    lane.handler,
    lane.timescale === undefined ? 'timescale unknown' : `${lane.timescale} Hz`,
  ]
    .filter(Boolean)
    .join(' · ');
  label.append(name, meta);
  return label;
}

/** [min, max] in ticks of `lane` if timescale unknown; otherwise `shared` converted to ticks. */
function rangeOf(lane: Lane, shared: [number, number] | null): [number, number] {
  if (lane.timescale !== undefined && shared) return [shared[0] * lane.timescale, shared[1] * lane.timescale];
  const starts = lane.spans.map((s) => s.start);
  const ends = lane.spans.map((s) => s.start + (s.duration ?? 0));
  return [Math.min(...starts), Math.max(...ends)];
}

function renderLane(
  lane: Lane,
  shared: [number, number] | null,
  selected: Segment | null,
  onSelect: (segment: Segment) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'lane';
  row.appendChild(laneLabel(lane));

  const track = document.createElement('div');
  track.className = 'track';
  const [min, max] = rangeOf(lane, shared);
  const span = Math.max(max - min, 1);
  const pct = (ticks: number) => `${((ticks - min) / span) * 100}%`;

  for (const s of lane.spans) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    if (s.duration === undefined) bar.classList.add('unknown');
    if (s.segment === selected) bar.classList.add('selected');
    bar.style.left = pct(s.start);
    bar.style.width = pct(min + (s.duration ?? 0));
    bar.title = tooltip(s, lane);
    bar.addEventListener('click', () => onSelect(s.segment));
    track.appendChild(bar);

    const d = s.deltaBefore;
    if (d !== undefined && d !== 0) {
      const mark = document.createElement('div');
      mark.className = d > 0 ? 'gap' : 'overlap';
      mark.style.left = pct(Math.min(s.start, s.start - d));
      mark.style.width = pct(min + Math.abs(d));
      mark.title = tooltip(s, lane);
      track.appendChild(mark);
    }
  }
  row.appendChild(track);
  return row;
}

export function renderTimeline(
  container: HTMLElement,
  summary: HTMLElement,
  lanes: Lane[],
  selected: Segment | null,
  onSelect: (segment: Segment) => void,
): void {
  const timed = lanes.filter((l) => l.timescale !== undefined);
  const shared: [number, number] | null = timed.length
    ? [
        Math.min(...timed.map((l) => Math.min(...l.spans.map((s) => s.start)) / l.timescale!)),
        Math.max(...timed.map((l) => Math.max(...l.spans.map((s) => s.start + (s.duration ?? 0))) / l.timescale!)),
      ]
    : null;

  const issues = lanes.reduce(
    (n, l) => n + l.spans.filter((s) => s.deltaBefore !== undefined && s.deltaBefore !== 0).length,
    0,
  );
  summary.textContent = `Timeline · ${lanes.length} lane${lanes.length === 1 ? '' : 's'} · ${issues} issue${issues === 1 ? '' : 's'}`;
  summary.classList.toggle('has-issues', issues > 0);
  container.replaceChildren(...lanes.map((l) => renderLane(l, shared, selected, onSelect)));
}
