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
import { saveAll, type Entry } from './save';
import { armHook, startEmePolling, startLicenseCapture, MAX_EXCHANGES } from './eme/capture';
import { buildModel, exportLog, segmentKids, type EmeModel } from './eme/model';
import { swapUuid } from './eme/bytes';
import type { NetExchange, RawEvent } from './eme/types';
import { renderDrmDetail, renderDrmList, renderDrmSequence, type DrmHandlers } from './render/drm';

const MAX_SEGMENTS = 200; // ponytail: fixed FIFO cap, make configurable if sessions need more
const MAX_EME_EVENTS = 5000;

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
const viewEl = $('view');
const armEl = $('arm') as HTMLButtonElement;
const armDotEl = $('arm-dot');
const segmentsMainEl = document.querySelector('main:not(#drm-main)') as HTMLElement;
const drmMainEl = $('drm-main');
const timelinePaneEl = $('timeline-pane');
const drmSeqPaneEl = $('drm-seq-pane');
const drmFlowEl = $('drm-flow');
const drmEmptyEl = $('drm-empty');
const drmDetailEl = $('drm-detail');
const drmHexEl = $('drm-hex');
const drmSeqEl = $('drm-seq');
const drmSeqSummaryEl = $('drm-seq-summary');

const segments: Segment[] = [];
let selected: Segment | null = null;
let filter = '';
let kindFilter: KindFilter = 'all';
const collapsedGroups = new Set<string>();
let lanes: Lane[] = [];
let lastBoxType: string | null = null; // re-opened in the next selected segment when present

type View = 'segments' | 'drm';
let view: View = 'segments';
const emeEvents: RawEvent[] = [];
const exchanges: NetExchange[] = [];
let emeModel: EmeModel = { items: [], sessions: [], kids: [], issues: [] };
let drmSelected: number | null = null;
let drmFilter = '';
let armed = false;
let drmDetailKey = ''; // detail pane is re-rendered only when this changes (keeps scroll + hex)
let kidSegments = new Map<string, { segment: Segment; box: string }>();

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
  if (view === 'drm') return refreshDrm();
  lanes = analyze(segments);
  const meta = metaOf(segments, lanes);
  const visible = segments.filter((s) => matches(s, meta.get(s)!, filter, kindFilter));
  countEl.textContent = `${segments.length} segment${segments.length === 1 ? '' : 's'} · ${lanes.length} track${lanes.length === 1 ? '' : 's'}`;
  emptyEl.textContent = segments.length
    ? 'No segments match the filter.'
    : 'Waiting for media segments… (only requests made while DevTools is open are captured)';
  emptyEl.style.display = visible.length ? 'none' : '';
  saveEl.disabled = segments.length === 0 && emeEvents.length === 0;
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

// ---------- DRM / EME view ----------

const drmHandlers: DrmHandlers = {
  onSelect: (id) => {
    drmSelected = id;
    refreshDrm();
  },
  onKid: (kid) => {
    const hit = kidSegments.get(kid);
    if (!hit) {
      statusEl.textContent = `KID ${kid} is not named by any captured segment`;
      return;
    }
    setView('segments');
    selectSegment(hit.segment, hit.box);
  },
  kidInSegments: (kid) => kidSegments.has(kid),
};

/** KID → newest segment whose tenc/pssh names it (also under the GUID byte order some PlayReady CDMs report). */
function indexKids(): void {
  kidSegments = new Map();
  for (const segment of segments) {
    for (const k of segmentKids([segment])) {
      for (const kid of [k.kid, swapUuid(k.kid)]) if (!kidSegments.has(kid) || k.source === 'tenc') kidSegments.set(kid, { segment, box: k.source });
    }
  }
}

function refreshDrm(): void {
  indexKids();
  emeModel = buildModel(emeEvents, exchanges, segmentKids(segments));
  const n = renderDrmList(drmFlowEl, emeModel, drmSelected, drmFilter, drmHandlers);
  countEl.textContent = `${emeModel.items.length} EME item${emeModel.items.length === 1 ? '' : 's'} · ${emeModel.sessions.length} session${emeModel.sessions.length === 1 ? '' : 's'}`;
  drmEmptyEl.textContent = emeModel.items.length ? 'No EME items match the filter.' : armed ? 'Hook active — waiting for EME calls…' : 'Not capturing. Click “Reload & capture EME”.';
  drmEmptyEl.style.display = n ? 'none' : '';
  const sel = emeModel.items.find((i) => i.id === drmSelected);
  if (drmSelected !== null && !sel) drmSelected = null;
  const key = sel ? `${sel.id}:${sel.status}:${sel.end}:${sel.issues.length}:${!!sel.exchange}:${kidSegments.size}` : `overview:${emeModel.items.length}:${exchanges.length}:${kidSegments.size}:${armed}`;
  if (key !== drmDetailKey) {
    drmDetailKey = key;
    renderDrmDetail(drmDetailEl, drmHexEl, emeModel, drmSelected, armed, drmHandlers);
  }
  renderDrmSequence(drmSeqEl, drmSeqSummaryEl, emeModel, drmSelected, drmHandlers);
  saveEl.disabled = segments.length === 0 && emeEvents.length === 0;
  updateViewButtons();
}

function updateViewButtons(): void {
  const drmBtn = viewEl.querySelector<HTMLElement>('button[data-view="drm"]')!;
  const calls = emeEvents.filter((e) => e.kind === 'call' || e.kind === 'event').length;
  drmBtn.textContent = calls ? `DRM · ${calls}` : 'DRM';
  armDotEl.classList.toggle('on', armed);
  armEl.title = armed ? 'EME hook active on this page. Click to reload and start a fresh capture.' : 'Reloads the page with a hook that records EME calls before any page script runs';
}

function setView(v: View): void {
  view = v;
  viewEl.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('selected', b.dataset.view === v));
  const drm = v === 'drm';
  segmentsMainEl.hidden = drm;
  timelinePaneEl.hidden = drm;
  kindEl.hidden = drm;
  drmMainEl.hidden = !drm;
  drmSeqPaneEl.hidden = !drm;
  armEl.hidden = !drm;
  filterEl.value = drm ? drmFilter : filter;
  filterEl.placeholder = drm ? 'Filter · name, widevine, error, kid:…, s:1' : 'Filter · name, url, track…';
  drmDetailKey = '';
  statusEl.textContent = '';
  refresh();
}

viewEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-view]');
  if (b) setView(b.dataset.view as View);
});

armEl.addEventListener('click', () => {
  statusEl.textContent = 'reloading with EME hook…';
  armHook();
});

startEmePolling(
  (batch, reset) => {
    if (reset) {
      emeEvents.length = 0;
      drmSelected = null;
    }
    emeEvents.push(...batch);
    if (emeEvents.length > MAX_EME_EVENTS) emeEvents.splice(0, emeEvents.length - MAX_EME_EVENTS);
    if (view === 'drm') refreshDrm();
    else updateViewButtons();
  },
  (a) => {
    armed = a;
    if (a && statusEl.textContent === 'reloading with EME hook…') statusEl.textContent = '';
    if (view === 'drm') refreshDrm();
    else updateViewButtons();
  },
);

startLicenseCapture((x) => {
  exchanges.push(x);
  if (exchanges.length > MAX_EXCHANGES) exchanges.splice(0, exchanges.length - MAX_EXCHANGES);
  if (view === 'drm') refreshDrm();
});

// re-evaluates time-based checks (e.g. a license message never answered) while the page is quiet
setInterval(() => {
  if (view === 'drm' && emeEvents.length) refreshDrm();
}, 3000);

/** EME log for "Save all": raw hook events plus the matched license exchanges (credential headers redacted). */
function emeEntries(): Entry[] {
  if (!emeEvents.length) return [];
  const log = exportLog(emeEvents, buildModel(emeEvents, exchanges, segmentKids(segments)));
  return [{ path: 'eme/eme-log.json', bytes: new TextEncoder().encode(JSON.stringify(log, null, 2)) }];
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
  if (view === 'drm') drmFilter = filterEl.value;
  else filter = filterEl.value;
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
    statusEl.textContent = await saveAll(segments, emeEntries());
  } catch (e) {
    statusEl.textContent = `save failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    saveEl.disabled = segments.length === 0 && emeEvents.length === 0;
  }
});

$('clear').addEventListener('click', () => {
  if (view === 'drm') {
    emeEvents.length = 0;
    exchanges.length = 0;
    drmSelected = null;
    statusEl.textContent = '';
    drmHexEl.replaceChildren();
    refresh();
    return;
  }
  segments.length = 0;
  selected = null;
  statusEl.textContent = '';
  treeEl.replaceChildren();
  fieldsEl.replaceChildren();
  hexEl.replaceChildren();
  refresh();
});

refresh();
