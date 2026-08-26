import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import { startCapture, type Segment } from './capture';
import { renderList } from './render/list';
import { renderTree } from './render/tree';
import { renderFields } from './render/fields';
import { renderHex } from './render/hex';

const MAX_SEGMENTS = 200; // ponytail: fixed FIFO cap, make configurable if sessions need more

const $ = (id: string) => document.getElementById(id)!;
const listEl = $('segments');
const treeEl = $('tree');
const fieldsEl = $('fields');
const hexEl = $('hex');
const countEl = $('count');
const emptyEl = $('empty');

const segments: Segment[] = [];
let selected: Segment | null = null;

function selectBox(segment: Segment, box: ParsedIsoBox): void {
  renderFields(fieldsEl, box);
  renderHex(hexEl, segment.bytes, box.view.byteOffset, box.size);
}

function selectSegment(segment: Segment): void {
  selected = segment;
  renderList(listEl, segments, selected, selectSegment);
  renderTree(treeEl, segment.boxes, (box) => selectBox(segment, box));
  fieldsEl.replaceChildren();
  hexEl.replaceChildren();
}

function refresh(): void {
  countEl.textContent = `${segments.length} segment${segments.length === 1 ? '' : 's'}`;
  emptyEl.style.display = segments.length ? 'none' : '';
  renderList(listEl, segments, selected, selectSegment);
}

startCapture((segment) => {
  segments.push(segment);
  if (segments.length > MAX_SEGMENTS) {
    const dropped = segments.splice(0, segments.length - MAX_SEGMENTS);
    if (selected && dropped.includes(selected)) selected = null;
  }
  refresh();
});

$('clear').addEventListener('click', () => {
  segments.length = 0;
  selected = null;
  treeEl.replaceChildren();
  fieldsEl.replaceChildren();
  hexEl.replaceChildren();
  refresh();
});

refresh();
