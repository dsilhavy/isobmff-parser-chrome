import type { Segment } from '../capture';
import type { Group, SegmentMeta } from '../list-model';
import { stripCommonPrefix } from '../timeline-model';
import { basename, chip, clock, el } from './util';

function row(segment: Segment, meta: SegmentMeta | undefined, selected: boolean, onSelect: (s: Segment) => void): HTMLElement {
  const r = el('div', 'seg-row');
  if (selected) r.classList.add('selected');
  r.title = segment.url + (segment.error ? `\nparse error: ${segment.error}` : '');
  const kind = meta?.kind ?? 'error';
  r.append(el('span', `badge ${kind}`, kind), el('span', 'seg-name', basename(segment.url)));
  if (segment.error) r.appendChild(el('span', 'seg-error', '!'));
  else r.appendChild(el('span', `seg-dot ${meta?.issue ?? ''}`));
  r.append(
    el('span', 'seg-size', segment.bytes.byteLength.toLocaleString()),
    el('span', 'seg-time', clock(segment.time)),
  );
  r.addEventListener('click', () => onSelect(segment));
  return r;
}

export function renderList(
  container: HTMLElement,
  groups: Group[],
  meta: Map<Segment, SegmentMeta>,
  selected: Segment | null,
  collapsed: Set<string>,
  onSelect: (segment: Segment) => void,
  onToggle: (template: string) => void,
): void {
  const names = stripCommonPrefix(groups.map((g) => g.template));
  container.replaceChildren(
    ...groups.flatMap((g, gi) => {
      const head = el('div', 'seg-group');
      if (collapsed.has(g.template)) head.classList.add('collapsed');
      head.title = g.template;
      head.append(
        el('span', 'tl-caret'),
        chip(g.handler),
        el('span', 'seg-group-name', names[gi]),
        el('span', 'seg-group-meta', `${g.segments.length} · ${g.size.toLocaleString()} B`),
      );
      head.addEventListener('click', () => onToggle(g.template));
      const rows = collapsed.has(g.template) ? [] : g.segments.map((s) => row(s, meta.get(s), s === selected, onSelect));
      return [head, ...rows];
    }),
  );
}
