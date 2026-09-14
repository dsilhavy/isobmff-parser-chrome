import type { FieldRange } from '../field-model';
import { el } from './util';

const ROW = 16;
const ROW_PX = 17;
const OVERSCAN = 6;
const HEADER_KEYS = new Set(['size', 'type', 'largesize', 'usertype']);

type Mode = 'box' | 'segment';

interface State {
  container: HTMLElement;
  bytes: Uint8Array;
  offset: number; // box start within the segment
  size: number;
  ranges: FieldRange[];
  first: number; // first byte shown
  rows: number;
}

// ponytail: module-level state; one hex pane per panel
let mode: Mode = 'box';
let state: State | null = null;
let hover: string | null = null;
let picked: string | null = null;
let bound = false;

const hex2 = (b: number) => b.toString(16).padStart(2, '0');
const activeKey = () => hover ?? picked;

function rangeAt(rel: number): FieldRange | undefined {
  return state?.ranges.find((r) => rel >= r.start && rel < r.end && !HEADER_KEYS.has(r.key));
}

function paintFields(): void {
  const key = activeKey();
  document.querySelectorAll<HTMLElement>('#fields [data-key]').forEach((r) => r.classList.toggle('active', r.dataset.key === key));
}

function paintBytes(): void {
  if (!state) return;
  const range = state.ranges.find((r) => r.key === activeKey());
  state.container.querySelectorAll<HTMLElement>('.hex-byte').forEach((b) => {
    const rel = Number(b.dataset.rel);
    b.classList.toggle('active', !!range && rel >= range.start && rel < range.end);
  });
}

/** Transient highlight from hovering a field row. */
export function hoverField(key: string | null): void {
  hover = key;
  paintBytes();
  paintFields();
}

function pick(key: string | null): void {
  picked = key;
  hoverField(null);
  document.querySelector('#fields [data-key].active')?.scrollIntoView({ block: 'nearest' });
}

function renderRow(s: State, r: number): HTMLElement {
  const row = el('div', 'hex-row');
  row.style.top = `${r * ROW_PX}px`;
  const start = s.first + r * ROW;
  const end = Math.min(start + ROW, s.bytes.byteLength);
  row.appendChild(el('span', 'hex-off', start.toString(16).padStart(8, '0')));
  const cells = el('span', 'hex-bytes');
  let ascii = '';
  const active = s.ranges.find((x) => x.key === activeKey());
  for (let i = start; i < end; i++) {
    const rel = i - s.offset;
    const inBox = rel >= 0 && rel < s.size;
    const b = s.bytes[i];
    const cell = el('span', 'hex-byte', hex2(b));
    cell.dataset.rel = String(rel);
    if (!inBox) cell.classList.add('dim');
    else if (s.ranges.some((x) => HEADER_KEYS.has(x.key) && rel >= x.start && rel < x.end)) cell.classList.add('hdr');
    if (active && rel >= active.start && rel < active.end) cell.classList.add('active');
    cells.appendChild(cell);
    ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
  }
  row.append(cells, el('span', 'hex-ascii', ascii));
  return row;
}

function renderWindow(): void {
  if (!state) return;
  const s = state;
  const body = s.container.querySelector<HTMLElement>('.hex-body');
  const scroller = s.container.closest<HTMLElement>('section');
  if (!body || !scroller) return;
  const top = body.offsetTop - scroller.scrollTop;
  const from = Math.max(0, Math.floor(-top / ROW_PX) - OVERSCAN);
  const to = Math.min(s.rows, Math.ceil((scroller.clientHeight - top) / ROW_PX) + OVERSCAN);
  const rows: HTMLElement[] = [];
  for (let r = from; r < to; r++) rows.push(renderRow(s, r));
  body.replaceChildren(...rows);
}

function bind(container: HTMLElement): void {
  if (bound) return;
  bound = true;
  container.closest('section')?.addEventListener('scroll', renderWindow, { passive: true });
  container.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const m = t.closest<HTMLElement>('.hex-mode button');
    if (m) {
      mode = m.dataset.mode as Mode;
      if (state) renderHex(state.container, state.bytes, state.offset, state.size, state.ranges);
      return;
    }
    const byte = t.closest<HTMLElement>('.hex-byte');
    if (byte) pick(rangeAt(Number(byte.dataset.rel))?.key ?? null);
  });
}

/** Hex dump of the segment around/inside the selected box: `bytes` is the segment buffer, box spans [offset, offset+size). */
export function renderHex(container: HTMLElement, bytes: Uint8Array, offset: number, size: number, ranges: FieldRange[]): void {
  bind(container);
  if (state?.offset !== offset || state.bytes !== bytes) picked = null;
  hover = null;
  const first = mode === 'box' ? Math.max(0, offset - ROW) : 0;
  const last = mode === 'box' ? Math.min(bytes.byteLength, offset + size + ROW) : bytes.byteLength;
  state = { container, bytes, offset, size, ranges, first, rows: Math.ceil((last - first) / ROW) };

  const head = el('div', 'pane-head hex-head');
  const seg = el('span', 'seg hex-mode');
  for (const m of ['box', 'segment'] as Mode[]) {
    const b = el('button', m === mode ? 'selected' : '', m);
    b.dataset.mode = m;
    seg.appendChild(b);
  }
  head.append(
    el('span', 'hex-title', 'Hex'),
    el('span', '', mode === 'box' ? 'box + 1 row context · header bytes shaded · hovered field highlighted' : `whole segment · ${bytes.byteLength.toLocaleString()} B`),
    seg,
  );

  const body = el('div', 'hex-body');
  body.style.height = `${state.rows * ROW_PX}px`;

  const legend = el('div', 'hex-legend');
  const item = (cls: string, text: string) => {
    const i = el('span', 'tl-legend');
    i.append(el('span', `swatch ${cls}`), text);
    return i;
  };
  legend.append(item('hdr', 'box header (size + type)'), item('active', 'hovered field'), el('span', '', ranges.length > 4 ? 'click a byte → selects the field that covers it' : 'no field map for this box type'));

  container.replaceChildren(head, body, legend);
  renderWindow();
  paintFields();
}
