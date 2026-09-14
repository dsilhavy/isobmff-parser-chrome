import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import type { Segment } from '../capture';
import { boxName } from '../box-names';
import { basename, el } from './util';

const INDENT = 14;
const children = (box: ParsedIsoBox): ParsedIsoBox[] => (box as { boxes?: ParsedIsoBox[] }).boxes ?? [];

// ponytail: module-level state; one tree per panel. Collapsed set resets when the segment changes.
let collapsed = new Set<ParsedIsoBox>();
let current: Segment | null = null;
let rows: { box: ParsedIsoBox; parent: ParsedIsoBox | null }[] = [];
let args: { container: HTMLElement; segment: Segment; selected: ParsedIsoBox | null; onSelect: (b: ParsedIsoBox) => void } | null = null;
let bound = false;

function desc(box: ParsedIsoBox): string {
  const name = boxName(box.type) ?? '';
  const n = (box as { samples?: unknown[] }).samples?.length;
  return box.type === 'trun' && n !== undefined ? `${name} · ${n} sample${n === 1 ? '' : 's'}` : name;
}

function row(box: ParsedIsoBox, depth: number, selected: boolean): HTMLElement {
  const r = el('div', 'tree-row');
  if (selected) r.classList.add('selected');
  r.style.paddingLeft = `${8 + depth * INDENT}px`;
  if (depth) {
    // longhands, so the hover/selected background-color still applies
    r.style.backgroundImage = Array(depth).fill('linear-gradient(var(--guide), var(--guide))').join(', ');
    r.style.backgroundPosition = Array.from({ length: depth }, (_, k) => `${INDENT + k * INDENT}px 0`).join(', ');
    r.style.backgroundSize = '1px 100%';
    r.style.backgroundRepeat = 'no-repeat';
  }
  const kids = children(box);
  r.append(
    el('span', 'tree-caret', kids.length ? (collapsed.has(box) ? '▶' : '▼') : ''),
    el('span', 'tree-type', box.type),
    el('span', 'tree-desc', desc(box)),
    el('span', 'tree-size', box.size.toLocaleString()),
  );
  return r;
}

function toggle(box: ParsedIsoBox): void {
  if (!collapsed.delete(box)) collapsed.add(box);
  rerender();
}

function rerender(): void {
  if (args) renderTree(args.container, args.segment, args.selected, args.onSelect);
}

function bind(container: HTMLElement): void {
  if (bound) return;
  bound = true;
  container.tabIndex = 0;
  container.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.tree-collapse-all')) {
      for (const { box } of rows) if (children(box).length) collapsed.add(box);
      rerender();
      return;
    }
    const r = t.closest<HTMLElement>('.tree-row');
    if (!r || !args) return;
    const i = [...container.querySelectorAll('.tree-row')].indexOf(r);
    const box = rows[i]?.box;
    if (!box) return;
    if (t.classList.contains('tree-caret') && children(box).length) toggle(box);
    else args.onSelect(box);
  });
  container.addEventListener('keydown', (e) => {
    if (!args) return;
    const i = rows.findIndex((r) => r.box === args!.selected);
    const sel = rows[i]?.box;
    let next: ParsedIsoBox | undefined;
    switch (e.key) {
      case 'ArrowDown': next = rows[Math.min(rows.length - 1, i + 1)]?.box; break;
      case 'ArrowUp': next = rows[Math.max(0, i - 1)]?.box; break;
      case 'ArrowRight':
        if (sel && children(sel).length) collapsed.has(sel) ? toggle(sel) : (next = children(sel)[0]);
        break;
      case 'ArrowLeft':
        if (sel && children(sel).length && !collapsed.has(sel)) toggle(sel);
        else next = rows[i]?.parent ?? undefined;
        break;
      case 'Enter': next = sel; break;
      default: return;
    }
    e.preventDefault();
    if (next && next !== args.selected) args.onSelect(next);
  });
}

export function renderTree(
  container: HTMLElement,
  segment: Segment,
  selected: ParsedIsoBox | null,
  onSelect: (box: ParsedIsoBox) => void,
): void {
  if (segment !== current) {
    current = segment;
    collapsed = new Set();
  }
  args = { container, segment, selected, onSelect };
  bind(container);

  const head = el('div', 'pane-head');
  head.append(
    el('span', 'mono', basename(segment.url)),
    el('span', '', `${segment.bytes.byteLength.toLocaleString()} B`),
    el('button', 'tree-collapse-all', '⊟ collapse all'),
  );

  rows = [];
  const out: HTMLElement[] = [head];
  const walk = (box: ParsedIsoBox, depth: number, parent: ParsedIsoBox | null) => {
    rows.push({ box, parent });
    out.push(row(box, depth, box === selected));
    if (!collapsed.has(box)) for (const c of children(box)) walk(c, depth + 1, box);
  };
  for (const b of segment.boxes) walk(b, 0, null);
  container.replaceChildren(...out);
  container.querySelector('.tree-row.selected')?.scrollIntoView({ block: 'nearest' });
}
