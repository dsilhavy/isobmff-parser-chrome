import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import { startCapture, type Segment } from './capture';
import { renderList } from './render/list';
import { renderTree } from './render/tree';
import { renderFields } from './render/fields';
import { renderHex } from './render/hex';
import { renderTimeline } from './render/timeline';
import { analyze } from './continuity';
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
const timelineEl = $('timeline');
const timelineSummaryEl = $('timeline-summary');

const segments: Segment[] = [];
let selected: Segment | null = null;

function selectBox(segment: Segment, box: ParsedIsoBox): void {
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

function selectSegment(segment: Segment, openTfdt = false): void {
  selected = segment;
  renderList(listEl, segments, selected, selectSegment);
  renderTimeline(timelineEl, timelineSummaryEl, analyze(segments), selected, selectSegment);
  renderTree(treeEl, segment.boxes, (box) => selectBox(segment, box));
  fieldsEl.replaceChildren();
  hexEl.replaceChildren();
  listEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  const tfdt = openTfdt ? findBox(segment.boxes, 'tfdt') : undefined;
  if (tfdt) selectBox(segment, tfdt);
}

function refresh(): void {
  countEl.textContent = `${segments.length} segment${segments.length === 1 ? '' : 's'}`;
  emptyEl.style.display = segments.length ? 'none' : '';
  saveEl.disabled = segments.length === 0;
  renderList(listEl, segments, selected, selectSegment);
  renderTimeline(timelineEl, timelineSummaryEl, analyze(segments), selected, selectSegment);
}

startCapture((segment) => {
  segments.push(segment);
  if (segments.length > MAX_SEGMENTS) {
    const dropped = segments.splice(0, segments.length - MAX_SEGMENTS);
    if (selected && dropped.includes(selected)) selected = null;
  }
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
