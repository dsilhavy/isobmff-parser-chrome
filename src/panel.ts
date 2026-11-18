import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import { parseSegment, type Segment } from './capture';
import { MAX_EXCHANGES, MAX_SEGMENTS, type Bridge, type CaptureEvent } from './bridge';
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
import { initGroups } from './sample-groups';
import type { TrackRunBox } from '@svta/cml-iso-bmff';
import { groupSegments, kindOf, matches, metaOf, type KindFilter } from './list-model';
import { mpdEntries, saveAll, type Entry } from './save';
import { addMpd, type MpdEntry, type Snapshot } from './mpd/store';
import { renderMpdList, renderMpdOutline, renderMpdSource, type ManifestHandlers, type SourceView } from './render/manifest';
import { armHook, startEmePolling } from './eme/capture';
import { buildModel, exportLog, segmentKids, type EmeModel } from './eme/model';
import { swapUuid } from './eme/bytes';
import type { NetExchange, RawEvent } from './eme/types';
import { renderDrmDetail, renderDrmList, renderDrmSequence, type DrmHandlers } from './render/drm';

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
const preserveEl = $('preserve') as HTMLInputElement;
const segmentsMainEl = $('segments-main');
const manifestMainEl = $('manifest-main');
const mpdListEl = $('mpd-list');
const mpdEmptyEl = $('mpd-empty');
const mpdOutlineEl = $('mpd-outline');
const mpdSourceEl = $('mpd-source');
const filterLabelEl = filterEl.closest('label') as HTMLElement;
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
let panelVisible = true; // the panel page is first loaded when its tab is shown

type View = 'segments' | 'manifest' | 'drm';
let view: View = 'segments';
const emeEvents: RawEvent[] = [];
const exchanges: NetExchange[] = [];
let emeModel: EmeModel = { items: [], sessions: [], kids: [], issues: [] };
let drmSelected: number | null = null;
let drmFilter = '';
let armed = false;
let drmDetailKey = ''; // detail pane is re-rendered only when this changes (keeps scroll + hex)
let kidSegments = new Map<string, { segment: Segment; box: string }>();

const mpds: MpdEntry[] = [];
let mpdUrl: string | null = null; // selected MPD; null = the first captured
let mpdSnapshotId: number | null = null; // null = follow the newest refresh
let mpdPath: string | null = null; // selected element in the outline
const mpdToggled = new Set<string>();
let mpdShown: Snapshot | undefined; // snapshot the outline and source currently show
let mpdSource: SourceView = { highlight: () => undefined };

const nothingToSave = () => segments.length === 0 && emeEvents.length === 0 && mpds.length === 0;

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
  return trunSamples(segment, moof, traf, trun as unknown as TrackRunBox, lane?.trexDefaults, codec, initGroups(lane?.init?.boxes, trackId));
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
  if (view === 'manifest') return refreshManifest();
  lanes = analyze(segments);
  const meta = metaOf(segments, lanes);
  const visible = segments.filter((s) => matches(s, meta.get(s)!, filter, kindFilter));
  countEl.textContent = `${segments.length} segment${segments.length === 1 ? '' : 's'} · ${lanes.length} track${lanes.length === 1 ? '' : 's'}`;
  emptyEl.textContent = segments.length
    ? 'No segments match the filter.'
    : 'Waiting for media segments… (requests are captured from the moment DevTools is opened)';
  emptyEl.style.display = visible.length ? 'none' : '';
  saveEl.disabled = nothingToSave();
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

// ---------- Manifest view ----------

const manifestHandlers: ManifestHandlers = {
  onSelect: (url, snapshotId) => {
    mpdUrl = url;
    mpdSnapshotId = snapshotId;
    refreshManifest();
  },
  onElement: (path, element) => {
    mpdPath = path;
    renderMpdOutline(mpdOutlineEl, mpdShown, mpdPath, mpdToggled, manifestHandlers);
    mpdSource.highlight(element.line, element.endLine);
  },
  onToggle: (path) => {
    if (!mpdToggled.delete(path)) mpdToggled.add(path);
    renderMpdOutline(mpdOutlineEl, mpdShown, mpdPath, mpdToggled, manifestHandlers);
  },
};

function refreshManifest(): void {
  const entry = mpds.find((e) => e.url === mpdUrl) ?? mpds[0];
  const snapshot = entry?.snapshots.find((s) => s.id === mpdSnapshotId) ?? entry?.snapshots.at(-1);
  if (snapshot && snapshot !== entry?.snapshots.find((s) => s.id === mpdSnapshotId)) mpdSnapshotId = null; // the chosen version left the history
  const total = mpds.reduce((n, e) => n + e.refreshes, 0);
  countEl.textContent = `${mpds.length} MPD${mpds.length === 1 ? '' : 's'} · ${total} response${total === 1 ? '' : 's'}`;
  mpdEmptyEl.style.display = mpds.length ? 'none' : '';
  saveEl.disabled = nothingToSave();
  renderMpdList(mpdListEl, mpds, snapshot, mpdSnapshotId === null, manifestHandlers);
  if (snapshot !== mpdShown) {
    // a new version: the outline keeps its open/closed state and selection by path, the source is rebuilt
    mpdShown = snapshot;
    renderMpdOutline(mpdOutlineEl, snapshot, mpdPath, mpdToggled, manifestHandlers);
    mpdSource = renderMpdSource(mpdSourceEl, entry, snapshot);
  }
  updateViewButtons();
}

function clearMpds(): void {
  mpds.length = 0;
  mpdUrl = mpdSnapshotId = mpdPath = null;
  mpdToggled.clear();
  if (view === 'manifest') refreshManifest();
  else updateViewButtons();
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

/** KID → newest segment whose tenc/pssh/seig names it (also under the GUID byte order some PlayReady CDMs report). */
function indexKids(): void {
  kidSegments = new Map();
  for (const segment of segments) {
    for (const k of segmentKids([segment])) {
      const box = k.source === 'seig' ? 'sgpd' : k.source;
      for (const kid of [k.kid, swapUuid(k.kid)]) if (!kidSegments.has(kid) || k.source === 'tenc') kidSegments.set(kid, { segment, box });
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
  saveEl.disabled = nothingToSave();
  updateViewButtons();
}

function updateViewButtons(): void {
  const drmBtn = viewEl.querySelector<HTMLElement>('button[data-view="drm"]')!;
  const calls = emeEvents.filter((e) => e.kind === 'call' || e.kind === 'event').length;
  drmBtn.textContent = calls ? `DRM · ${calls}` : 'DRM';
  viewEl.querySelector<HTMLElement>('button[data-view="manifest"]')!.textContent = mpds.length ? `Manifest · ${mpds.length}` : 'Manifest';
  armDotEl.classList.toggle('on', armed);
  armEl.title = armed ? 'EME hook active on this page. Click to reload and start a fresh capture.' : 'Reloads the page with a hook that records EME calls before any page script runs';
}

function setView(v: View): void {
  view = v;
  viewEl.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('selected', b.dataset.view === v));
  const drm = v === 'drm';
  segmentsMainEl.hidden = v !== 'segments';
  timelinePaneEl.hidden = v !== 'segments';
  kindEl.hidden = v !== 'segments';
  manifestMainEl.hidden = v !== 'manifest';
  filterLabelEl.hidden = v === 'manifest'; // ponytail: no filter in the Manifest view yet
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
  poller.expectHook();
});

const poller = startEmePolling(
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

// re-evaluates time-based checks (e.g. a license message never answered) while the page is quiet
setInterval(() => {
  if (panelVisible && view === 'drm' && emeEvents.length) refreshDrm();
}, 3000);

/** EME log for "Save all": raw hook events plus the matched license exchanges (credential headers redacted). */
function emeEntries(): Entry[] {
  if (!emeEvents.length) return [];
  const log = exportLog(emeEvents, buildModel(emeEvents, exchanges, segmentKids(segments)));
  return [{ path: 'eme/eme-log.json', bytes: new TextEncoder().encode(JSON.stringify(log, null, 2)) }];
}

function clearSegments(): void {
  segments.length = 0;
  selected = null;
  statusEl.textContent = '';
  treeEl.replaceChildren();
  fieldsEl.replaceChildren();
  hexEl.replaceChildren();
  refresh();
}

// ---------- capture (DevTools page → panel) ----------

const PRESERVE_KEY = 'isobmff.preserveLog';
try {
  preserveEl.checked = localStorage.getItem(PRESERVE_KEY) === '1';
} catch {
  /* storage unavailable: default (off) */
}
preserveEl.addEventListener('change', () => {
  try {
    localStorage.setItem(PRESERVE_KEY, preserveEl.checked ? '1' : '0');
  } catch {
    /* not persisted */
  }
});

/** Events come from the DevTools page, another realm: clone so every object and typed array is one of ours. */
function onCapture(foreign: CaptureEvent): void {
  const e = structuredClone(foreign);
  if (e.type === 'segment') {
    segments.push(parseSegment(e.segment));
    if (segments.length > MAX_SEGMENTS) {
      const dropped = segments.splice(0, segments.length - MAX_SEGMENTS);
      if (selected && dropped.includes(selected)) selected = null;
    }
    refresh();
  } else if (e.type === 'exchange') {
    exchanges.push(e.exchange);
    if (exchanges.length > MAX_EXCHANGES) exchanges.splice(0, exchanges.length - MAX_EXCHANGES);
    if (view === 'drm') refreshDrm();
  } else if (e.type === 'mpd') {
    addMpd(mpds, e.mpd);
    if (view === 'manifest') refreshManifest();
    else updateViewButtons();
  } else if (!preserveEl.checked) {
    // the page navigated or reloaded
    if (segments.length) clearSegments();
    if (mpds.length) clearMpds();
  }
}

function setVisible(v: boolean): void {
  panelVisible = v;
  poller.setVisible(v);
  if (v && view === 'drm') refreshDrm();
}

type PanelWindow = Window & { __isobmffBridge?: Bridge; __isobmffReady?: () => void };
const panelWindow = window as PanelWindow;
let connected = false;
/** The DevTools page sets `__isobmffBridge` when the panel is shown, before or after this script runs. */
function connect(): void {
  const bridge = panelWindow.__isobmffBridge;
  if (!bridge || connected) return;
  connected = true;
  bridge.connect({ event: onCapture, visible: setVisible });
}
panelWindow.__isobmffReady = connect;

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
    statusEl.textContent = await saveAll(segments, [...mpdEntries(mpds.flatMap((m) => m.snapshots.map((s) => ({ url: m.url, text: s.text })))), ...emeEntries()]);
  } catch (e) {
    statusEl.textContent = `save failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    saveEl.disabled = nothingToSave();
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
  if (view === 'manifest') {
    statusEl.textContent = '';
    clearMpds();
    return;
  }
  clearSegments();
});

refresh();
connect();
