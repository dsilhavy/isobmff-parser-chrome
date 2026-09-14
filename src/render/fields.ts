import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import { boxName } from '../box-names';
import { derived, type FieldRange } from '../field-model';
import { hoverField } from './hex';
import { el } from './util';

const HIDDEN_KEYS = new Set(['type', 'size', 'view', 'boxes', 'largesize', 'usertype']);
const SAMPLE_ROW_CAP = 50;

function formatValue(value: unknown): string {
  if (value instanceof Uint8Array) {
    const head = [...value.subarray(0, 32)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return `${value.byteLength} bytes${value.byteLength ? `: ${head}${value.byteLength > 32 ? ' …' : ''}` : ''}`;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  return String(value);
}

/** Array of uniform objects (e.g. trun samples) rendered as its own table. */
function isObjectArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null && !(value[0] instanceof Uint8Array);
}

function renderObjectArray(name: string, rows: Record<string, unknown>[], timescale: number | undefined): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.appendChild(el('h3', '', `${name} (${rows.length})`));

  const wrap = el('div', 'sample-table');
  const table = document.createElement('table');
  const columns = Object.keys(rows[0]);
  const headRow = table.createTHead().insertRow();
  headRow.appendChild(el('th', '', '#'));
  for (const col of columns) headRow.appendChild(el('th', '', col));

  const body = table.createTBody();
  const addRows = (from: number, to: number) => {
    for (let i = from; i < Math.min(to, rows.length); i++) {
      const tr = body.insertRow();
      tr.insertCell().textContent = String(i);
      for (const col of columns) {
        const v = rows[i][col];
        const td = tr.insertCell();
        td.textContent = formatValue(v);
        if (typeof v === 'number') td.className = 'num';
        const d = derived(col, v, timescale);
        if (d) td.title = d;
      }
    }
  };
  addRows(0, SAMPLE_ROW_CAP);
  wrap.appendChild(table);
  frag.appendChild(wrap);

  if (rows.length > SAMPLE_ROW_CAP) {
    const more = el('button', 'more', `Show all ${rows.length} rows`);
    more.addEventListener('click', () => {
      addRows(SAMPLE_ROW_CAP, rows.length);
      more.remove();
    });
    frag.appendChild(more);
  }
  return frag;
}

export function renderFields(container: HTMLElement, box: ParsedIsoBox, timescale: number | undefined, ranges: FieldRange[]): void {
  container.replaceChildren();
  const b = box as unknown as Record<string, unknown>;
  const offset = box.view.byteOffset;
  const total = (b.largesize as number | undefined) ?? box.size;

  const head = el('div', 'pane-head fields-head');
  head.append(el('span', 'fields-type', box.type), el('span', 'fields-name', boxName(box.type) ?? ''));
  if (typeof b.version === 'number' && typeof b.flags === 'number') {
    head.appendChild(el('span', 'fields-full', `FullBox · v${b.version} · flags ${derived('flags', b.flags, undefined)}`));
  }
  head.appendChild(el('span', 'fields-pos', `${total.toLocaleString()} B @ 0x${offset.toString(16)} (${offset}) – 0x${(offset + total - 1).toString(16)}`));
  container.appendChild(head);

  const entries = Object.entries(b).filter(([k, v]) => !HIDDEN_KEYS.has(k) && v !== undefined);
  const scalar = entries.filter(([, v]) => !isObjectArray(v));
  const tables = entries.filter(([, v]) => isObjectArray(v));
  const content = el('div', 'fields-content');

  if (!entries.length) {
    content.appendChild(el('p', 'muted', (b.boxes as unknown[] | undefined)?.length ? 'Container box.' : 'No decoded fields (no reader for this box type).'));
  }

  if (scalar.length) {
    const grid = el('div', 'fields-grid');
    for (const [key, value] of scalar) {
      const k = el('div', 'fields-key', key);
      const val = el('div', 'fields-val');
      val.appendChild(el('span', 'fields-raw', formatValue(value)));
      const d = derived(key, value, timescale);
      if (d) val.appendChild(el('span', 'fields-derived', d));
      const range = ranges.find((r) => r.key === key);
      if (range) {
        val.appendChild(el('span', 'fields-bytes', `bytes ${range.start}–${range.end - 1} · ${range.type}`));
        k.dataset.key = val.dataset.key = key;
        for (const cell of [k, val]) {
          cell.addEventListener('mouseenter', () => hoverField(key));
          cell.addEventListener('mouseleave', () => hoverField(null));
        }
      }
      grid.append(k, val);
    }
    content.appendChild(grid);
  }

  for (const [key, value] of tables) content.appendChild(renderObjectArray(key, value as Record<string, unknown>[], timescale));
  container.appendChild(content);
}
