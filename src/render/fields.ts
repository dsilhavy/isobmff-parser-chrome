import type { ParsedIsoBox } from '@svta/cml-iso-bmff';

const HIDDEN_KEYS = new Set(['type', 'size', 'view', 'boxes']);
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

function renderObjectArray(name: string, rows: Record<string, unknown>[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const h = document.createElement('h3');
  h.textContent = `${name} (${rows.length})`;
  frag.appendChild(h);

  const table = document.createElement('table');
  const columns = Object.keys(rows[0]);
  const headRow = table.createTHead().insertRow();
  const idx = document.createElement('th');
  idx.textContent = '#';
  headRow.appendChild(idx);
  for (const col of columns) {
    const th = document.createElement('th');
    th.textContent = col;
    headRow.appendChild(th);
  }

  const body = table.createTBody();
  const addRows = (from: number, to: number) => {
    for (let i = from; i < Math.min(to, rows.length); i++) {
      const tr = body.insertRow();
      tr.insertCell().textContent = String(i);
      for (const col of columns) tr.insertCell().textContent = formatValue(rows[i][col]);
    }
  };
  addRows(0, SAMPLE_ROW_CAP);
  frag.appendChild(table);

  if (rows.length > SAMPLE_ROW_CAP) {
    const more = document.createElement('button');
    more.textContent = `Show all ${rows.length} rows`;
    more.addEventListener('click', () => {
      addRows(SAMPLE_ROW_CAP, rows.length);
      more.remove();
    });
    frag.appendChild(more);
  }
  return frag;
}

export function renderFields(container: HTMLElement, box: ParsedIsoBox): void {
  container.replaceChildren();

  const h = document.createElement('h3');
  h.textContent = `${box.type} — ${box.size} B @ offset ${box.view.byteOffset}`;
  container.appendChild(h);

  const entries = Object.entries(box).filter(([k]) => !HIDDEN_KEYS.has(k));
  const scalar = entries.filter(([, v]) => !isObjectArray(v));
  const tables = entries.filter(([, v]) => isObjectArray(v));

  if (!entries.length) {
    const p = document.createElement('p');
    p.textContent = (box as { boxes?: unknown[] }).boxes?.length
      ? 'Container box.'
      : 'No decoded fields (no reader for this box type).';
    container.appendChild(p);
  }

  if (scalar.length) {
    const table = document.createElement('table');
    for (const [key, value] of scalar) {
      const tr = table.insertRow();
      const th = document.createElement('th');
      th.textContent = key;
      tr.appendChild(th);
      tr.insertCell().textContent = formatValue(value);
    }
    container.appendChild(table);
  }

  for (const [key, value] of tables) {
    container.appendChild(renderObjectArray(key, value as Record<string, unknown>[]));
  }
}
