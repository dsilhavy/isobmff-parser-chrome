import type { Segment } from '../capture';
import type { Change } from '../diff';
import { basename, el } from './util';

/** Field-level differences between two init segments, `a` = the selected one. */
export function renderDiff(container: HTMLElement, a: Segment, b: Segment, changes: Change[]): void {
  container.replaceChildren();
  const head = el('div', 'pane-head fields-head');
  head.append(el('span', 'fields-type', 'diff'), el('span', 'fields-name', `${basename(a.url)} ↔ ${basename(b.url)}`));
  head.appendChild(el('span', 'fields-pos', `${changes.length} difference${changes.length === 1 ? '' : 's'}`));
  container.appendChild(head);
  const content = el('div', 'fields-content');
  if (!changes.length) {
    content.appendChild(el('p', 'muted', 'Identical decoded fields.'));
  } else {
    const wrap = el('div', 'sample-table diff-table');
    const table = document.createElement('table');
    const hr = table.createTHead().insertRow();
    for (const h of ['field', basename(a.url), basename(b.url)]) hr.appendChild(el('th', '', h));
    const body = table.createTBody();
    for (const c of changes) {
      const tr = body.insertRow();
      tr.className = c.a === undefined ? 'added' : c.b === undefined ? 'removed' : 'changed';
      tr.insertCell().textContent = c.path;
      tr.insertCell().textContent = c.a ?? '—';
      tr.insertCell().textContent = c.b ?? '—';
    }
    wrap.appendChild(table);
    content.appendChild(wrap);
  }
  container.appendChild(content);
}
