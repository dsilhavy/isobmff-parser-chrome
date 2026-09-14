import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import { startCapture, type Segment } from './capture';
import { renderList } from './render/list';
import { renderTree } from './render/tree';
import { renderFields } from './render/fields';
import { renderHex } from './render/hex';
import { renderTimeline } from './render/timeline';
import { analyze } from './continuity';
import { groupSegments, matches, metaOf, type KindFilter } from './list-model';
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

function selectBox(segment: Segment, box: ParsedIsoBox): void {
  renderTree(treeEl, segment, box, (b) => selectBox(segment, b));
  renderFields(fieldsEl, box);
  renderHex(hexEl, segment.bytes, box.view.byteOffset, box.size);
}

/** Depth-first search for the first box of `type`. */
function findBox(boxes: ParsedIsoBox[], type: string): ParsedIsoBox | undefined {
  for (const b of boxes) {
    if (b.type === type) return b;
    const hit = findBox((b as { boxes?: ParsedIsoBox[] }).boxes ?? [], type);
    if (hit) return hit;
  }
  return undefined;
}

function refresh(): void {
  const lanes = analyze(segments);
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
  renderTimeline(timelineEl, timelineSummaryEl, lanes, selected, selectSegment);
}

function selectSegment(segment: Segment, openTfdt = false): void {
  selected = segment;
  refresh();
  renderTree(treeEl, segment, null, (box) => selectBox(segment, box));
  fieldsEl.replaceChildren();
  hexEl.replaceChildren();
  listEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  const tfdt = openTfdt ? findBox(segment.boxes, 'tfdt') : undefined;
  if (tfdt) selectBox(segment, tfdt);
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
