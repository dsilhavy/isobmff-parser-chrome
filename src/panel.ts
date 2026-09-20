import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import { startCapture, type Segment } from './capture';
import { renderList } from './render/list';
import { renderTree } from './render/tree';
import { renderFields } from './render/fields';
import { renderHex } from './render/hex';
import { renderTimeline } from './render/timeline';
import { renderDiff } from './render/diff';
import { diff } from './diff';
import { findBox, pathTo } from './boxes';
import { av1ReducedStill, trunSamples, type Codec, type SampleInfo } from './samples';
import { analyze, type Lane } from './continuity';
import { eventsOf } from './timeline-model';
import { fieldOffsets } from './field-model';
import type { TrackRunBox } from '@svta/cml-iso-bmff';
import { groupSegments, kindOf, matches, metaOf, type KindFilter } from './list-model';
import { saveAll } from './save';

const MAX_SEGMENTS = 200; // ponytail: fixed FIFO cap, make configurable if sessions need more

const $ = (id: string) => document.getElementById(id)!;
const listEl = $('segments');
const treeEl = $('tree');
const fieldsEl = $('fields');
const hexEl = $('hex');
const countEl = $('count');
const emptyEl = $('empty');
const statusEl = $('status');
const saveEl = $('save') as HTMLButtonElement;
const filterEl = $('filter') as HTMLInputElement;
const kindEl = $('kind');
const timelineEl = $('timeline');
const timelineSummaryEl = $('timeline-summary');

const segments: Segment[] = [];
let selected: Segment | null = null;
let filter = '';
let kindFilter: KindFilter = 'all';
const collapsedGroups = new Set<string>();
let lanes: Lane[] = [];
let lastBoxType: string | null = null; // re-opened in the next selected segment when present

/** Timescale for the time fields of `box`: its own `timescale` field, else the one lane timescale this segment belongs to. */
function timescaleFor(segment: Segment, box: ParsedIsoBox): number | undefined {
  const own = (box as { timescale?: unknown }).timescale;
  if (typeof own === 'number') return own;
  const scales = new Set(lanes.filter((l) => l.spans.some((s) => s.segment === segment)).map((l) => l.timescale));
  return scales.size === 1 ? [...scales][0] : undefined;
}

/** Parser selection from the lane's codec string and init configuration record. */
function codecFor(lane: Lane): Codec | undefined {
  const init = lane.init;
  const type = lane.codec?.slice(0, 4);
  if (!init || !type) return undefined;
  const nal = (box: string) => (findBox(init.boxes, box) as { lengthSizeMinusOne?: number } | undefined)?.lengthSizeMinusOne;
  if (['avc1', 'avc2', 'avc3', 'avc4'].includes(type)) return { kind: 'avc', nalLengthSize: (nal('avcC') ?? 3) + 1 };
  if (type === 'hvc1' || type === 'hev1') return { kind: 'hevc', nalLengthSize: (nal('hvcC') ?? 3) + 1 };
  if (type === 'av01') {
    const av1C = findBox(init.boxes, 'av1C') as { configOBUs?: Uint8Array } | undefined;
    return { kind: 'av1', reducedStill: av1C?.configOBUs ? av1ReducedStill(av1C.configOBUs) : false };
  }
  return undefined;
}

/** Resolved samples of a selected trun: defaults, init and codec come from the segment's lane. */
function samplesFor(segment: Segment, trun: ParsedIsoBox): SampleInfo[] | undefined {
  const path = pathTo(segment.boxes, trun);
  const traf = path?.at(-1);
  const moof = path?.at(-2);
  if (!traf || !moof || moof.type !== 'moof') return undefined;
  const trackId = (findBox([traf], 'tfhd') as { trackId?: number } | undefined)?.trackId;
  const lane = lanes.find((l) => l.trackId === trackId && l.spans.some((s) => s.segment === segment));
  // encrypted samples: frame headers are ciphertext, flags-based class only
  const encrypted = !!findBox([traf], 'senc') || !!(lane?.init && findBox(lane.init.boxes, 'tenc'));
  const codec = lane && !encrypted ? codecFor(lane) : undefined;
  return trunSamples(segment, moof, traf, trun as unknown as TrackRunBox, lane?.trexDefaults, codec);
}

function selectBox(segment: Segment, box: ParsedIsoBox): void {
  lastBoxType = box.type;
  renderTree(treeEl, segment, box, (b) => selectBox(segment, b), diffCandidates(segment), (other) => showDiff(segment, other));
  const ranges = fieldOffsets(box);
  renderFields(fieldsEl, box, timescaleFor(segment, box), ranges, box.type === 'trun' ? samplesFor(segment, box) : undefined);
  renderHex(hexEl, segment.bytes, box.view.byteOffset, box.size, ranges);
}

function refresh(): void {
  lanes = analyze(segments);
  const meta = metaOf(segments, lanes);
  const visible = segments.filter((s) => matches(s, meta.get(s)!, filter, kindFilter));
  countEl.textContent = `${segments.length} segment${segments.length === 1 ? '' : 's'} · ${lanes.length} track${lanes.length === 1 ? '' : 's'}`;
  emptyEl.textContent = segments.length
    ? 'No segments match the filter.'
    : 'Waiting for media segments… (only requests made while DevTools is open are captured)';
  emptyEl.style.display = visible.length ? 'none' : '';
  saveEl.disabled = segments.length === 0;
  renderList(listEl, groupSegments(visible, meta), meta, selected, collapsedGroups, selectSegment, (template) => {
    if (!collapsedGroups.delete(template)) collapsedGroups.add(template);
    refresh();
  });
  renderTimeline(timelineEl, timelineSummaryEl, lanes, eventsOf(segments, lanes), selected, selectSegment);
}

/** Other init segments, most recent first, offered for a field diff when `segment` is an init. */
function diffCandidates(segment: Segment): Segment[] {
  if (kindOf(segment) !== 'init') return [];
  return segments.filter((s) => s !== segment && kindOf(s) === 'init').reverse();
}

function showDiff(a: Segment, b: Segment): void {
  renderDiff(fieldsEl, a, b, diff(a.boxes, b.boxes));
  hexEl.replaceChildren();
}

/** Selects `segment` and re-opens `open`, else the last selected box type, when the segment has such a box. */
function selectSegment(segment: Segment, open?: string): void {
  selected = segment;
  refresh();
  renderTree(treeEl, segment, null, (box) => selectBox(segment, box), diffCandidates(segment), (other) => showDiff(segment, other));
  fieldsEl.replaceChildren();
  hexEl.replaceChildren();
  listEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  const type = open ?? lastBoxType;
  const box = type ? findBox(segment.boxes, type) : undefined;
  if (box) selectBox(segment, box);
}

startCapture((segment) => {
  segments.push(segment);
  if (segments.length > MAX_SEGMENTS) {
    const dropped = segments.splice(0, segments.length - MAX_SEGMENTS);
    if (selected && dropped.includes(selected)) selected = null;
  }
  refresh();
});

filterEl.addEventListener('input', () => {
  filter = filterEl.value;
  refresh();
});

kindEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-kind]');
  if (!b) return;
  kindFilter = b.dataset.kind as KindFilter;
  kindEl.querySelectorAll('button').forEach((x) => x.classList.toggle('selected', x === b));
  refresh();
});

saveEl.addEventListener('click', async () => {
  saveEl.disabled = true;
  statusEl.textContent = 'saving…';
  try {
    statusEl.textContent = await saveAll(segments);
  } catch (e) {
    statusEl.textContent = `save failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    saveEl.disabled = segments.length === 0;
  }
});

$('clear').addEventListener('click', () => {
  segments.length = 0;
  selected = null;
  statusEl.textContent = '';
  treeEl.replaceChildren();
  fieldsEl.replaceChildren();
  hexEl.replaceChildren();
  refresh();
});

refresh();
