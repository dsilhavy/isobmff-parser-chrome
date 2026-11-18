import type { Finding, FindingGroup } from '../findings';
import { clock, el } from './util';

export interface ReportHandlers {
  onGroup(key: string): void;
  /** Open the place a finding points to (segment box or MPD line). */
  onOpen(finding: Finding): void;
}

const MAX_OCCURRENCES = 500; // rows rendered per finding

const count = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** Left pane: one row per distinct finding. Returns the number of rows. */
export function renderReportList(container: HTMLElement, groups: FindingGroup[], selected: string | null, handlers: ReportHandlers): number {
  container.replaceChildren(
    ...groups.map((g) => {
      const row = el('div', 'rep-row');
      if (g.key === selected) row.classList.add('selected');
      row.title = `${g.id}${g.clause ? `\n${g.clause}` : ''}`;
      row.append(
        el('span', `sev ${g.severity}`, g.severity),
        el('span', 'rep-source', g.source === 'mpd' ? 'MPD' : 'segment'),
        el('span', 'rep-msg', g.message),
        el('span', 'rep-clause', g.clause ?? ''),
        el('span', 'rep-count', `×${g.findings.length.toLocaleString()}`),
      );
      row.addEventListener('click', () => handlers.onGroup(g.key));
      return row;
    }),
  );
  return groups.length;
}

/** Right pane: the selected finding and where it occurs. */
export function renderReportDetail(container: HTMLElement, group: FindingGroup | undefined, handlers: ReportHandlers): void {
  container.replaceChildren();
  if (!group) return;
  const head = el('div', 'rep-detail-head');
  head.append(el('span', `sev ${group.severity}`, group.severity), el('strong', 'rep-detail-msg', group.message));
  const grid = el('div', 'fields-grid rep-facts');
  const facts: [string, string | undefined][] = [
    ['rule', group.id],
    ['clause', group.clause],
    ['requires', group.requirement],
    ['lens', group.lens],
    ['found in', count(group.findings.length, group.source === 'mpd' ? 'MPD version' : 'segment')],
  ];
  for (const [key, value] of facts) {
    if (!value) continue;
    const v = el('div', 'fields-val');
    v.appendChild(el('span', 'fields-raw', value));
    grid.append(el('div', 'fields-key', key), v);
  }
  const list = el('div', 'rep-occurrences');
  for (const f of group.findings.slice(0, MAX_OCCURRENCES)) {
    const row = el('div', 'rep-occ');
    row.title = f.location.kind === 'segment' ? f.location.segment.url : f.location.url;
    row.append(el('span', 'rep-where', f.where), el('span', 'seg-time', clock(new Date(f.time))));
    if (f.detail) row.appendChild(el('div', 'rep-occ-detail', f.detail));
    row.addEventListener('click', () => handlers.onOpen(f));
    list.appendChild(row);
  }
  container.append(head, grid, el('div', 'pane-head', 'Occurrences · click to open'), list);
  if (group.findings.length > MAX_OCCURRENCES) container.appendChild(el('p', 'mpd-truncated', `Showing the first ${MAX_OCCURRENCES} of ${group.findings.length.toLocaleString()}.`));
}
