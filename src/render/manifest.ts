import type { MpdSummary } from '../mpd/model';
import type { MpdEntry, Snapshot } from '../mpd/store';
import type { XmlElement } from '../mpd/xml';
import { attr } from '../mpd/xml';
import { highlightLines, type Token } from '../mpd/highlight';
import { basename, clock, el } from './util';

const MAX_LINES = 20_000; // ponytail: source lines rendered; beyond that the view is truncated (virtualise if MPDs get larger)
const CHUNK = 100; // lines per block; blocks off screen are skipped by the browser (content-visibility)
const MAX_CHILDREN = 300; // outline rows per parent, e.g. the S elements of a long SegmentTimeline
const OPEN_BY_DEFAULT = new Set(['MPD', 'Period', 'AdaptationSet']);

export interface ManifestHandlers {
  /** `snapshotId` null follows the newest refresh of that MPD. */
  onSelect(url: string, snapshotId: number | null): void;
  onElement(path: string, element: XmlElement): void;
  onToggle(path: string): void;
}

const seconds = (n: number | undefined) => (n === undefined ? undefined : `${+n.toFixed(3)} s`);

// ---------- MPD list with refresh history ----------

export function renderMpdList(container: HTMLElement, entries: MpdEntry[], current: Snapshot | undefined, following: boolean, handlers: ManifestHandlers): void {
  container.replaceChildren(
    ...entries.flatMap((entry) => {
      const latest = entry.snapshots.at(-1);
      const head = el('div', 'seg-group mpd-group');
      head.title = entry.url;
      const type = latest?.summary?.type;
      head.append(
        el('span', `badge ${type === 'dynamic' ? 'media' : 'init'}`, type ?? 'mpd'),
        el('span', 'seg-group-name', basename(entry.url)),
        el('span', 'seg-group-meta', `${entry.refreshes} response${entry.refreshes === 1 ? '' : 's'} · ${entry.snapshots.length} version${entry.snapshots.length === 1 ? '' : 's'}`),
      );
      head.addEventListener('click', () => handlers.onSelect(entry.url, null));
      const rows = [...entry.snapshots].reverse().map((s) => {
        const r = el('div', 'seg-row');
        if (s === current) r.classList.add('selected');
        const isLatest = s === latest;
        r.title = [entry.url, ...s.doc.errors.map((e) => `line ${e.line}: ${e.message}`)].join('\n');
        r.append(el('span', 'seg-name', isLatest ? 'latest' : `version ${s.id}`));
        if (isLatest && following && s === current) r.title = `Following the newest refresh\n${r.title}`;
        if (s.count > 1) r.appendChild(el('span', 'mpd-count', `×${s.count}`));
        if (s.doc.errors.length) r.appendChild(el('span', 'seg-error', '!'));
        else r.appendChild(el('span', 'seg-dot'));
        r.append(el('span', 'seg-size', s.text.length.toLocaleString()), el('span', 'seg-time', clock(new Date(s.time))));
        r.addEventListener('click', () => handlers.onSelect(entry.url, isLatest ? null : s.id));
        return r;
      });
      return [head, ...rows];
    }),
  );
}

// ---------- summary + element outline ----------

function summaryRows(s: MpdSummary): [string, string][] {
  const reps = s.periods.flatMap((p) => p.adaptationSets).flatMap((a) => a.representations).length;
  const sets = s.periods.flatMap((p) => p.adaptationSets).length;
  const rows: [string, string | undefined][] = [
    ['type', s.type],
    ['profiles', s.profiles.join('\n') || undefined],
    ['mediaPresentationDuration', seconds(s.mediaPresentationDuration)],
    ['minBufferTime', seconds(s.minBufferTime)],
    ['minimumUpdatePeriod', seconds(s.minimumUpdatePeriod)],
    ['timeShiftBufferDepth', seconds(s.timeShiftBufferDepth)],
    ['suggestedPresentationDelay', seconds(s.suggestedPresentationDelay)],
    ['availabilityStartTime', s.availabilityStartTime],
    ['publishTime', s.publishTime],
    ['content', `${s.periods.length} Period${s.periods.length === 1 ? '' : 's'} · ${sets} AdaptationSet${sets === 1 ? '' : 's'} · ${reps} Representation${reps === 1 ? '' : 's'}`],
  ];
  return rows.filter((r): r is [string, string] => r[1] !== undefined);
}

/** Short description of an element for its outline row. */
export function describe(element: XmlElement): string {
  const a = (name: string) => attr(element, name);
  const join = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' · ');
  switch (element.local) {
    case 'MPD':
      return join(a('type') ?? 'static');
    case 'Period':
      return join(a('id') && `id ${a('id')}`, a('start') && `start ${a('start')}`, a('duration') && `duration ${a('duration')}`);
    case 'AdaptationSet':
      return join(a('contentType') ?? a('mimeType'), a('lang'), a('codecs'));
    case 'Representation':
      return join(a('id') && `id ${a('id')}`, a('bandwidth') && `${Math.round(Number(a('bandwidth')) / 1000).toLocaleString()} kbit/s`, a('width') && a('height') && `${a('width')}×${a('height')}`, a('codecs'));
    default: {
      const text = element.children.length ? '' : element.text.trim();
      const s = text || element.attrs.filter((x) => !x.name.startsWith('xmlns')).map((x) => `${x.name}="${x.value}"`).join(' ');
      return s.length > 90 ? `${s.slice(0, 90)}…` : s;
    }
  }
}

/** `toggled` holds the paths whose open state differs from the default (MPD, Period and AdaptationSet start open). */
export const isOpen = (element: XmlElement, path: string, toggled: Set<string>): boolean => OPEN_BY_DEFAULT.has(element.local) !== toggled.has(path);

export function renderMpdOutline(container: HTMLElement, snapshot: Snapshot | undefined, selectedPath: string | null, toggled: Set<string>, handlers: ManifestHandlers): void {
  container.replaceChildren();
  if (!snapshot) return;
  if (snapshot.summary) {
    const grid = el('div', 'fields-grid mpd-summary');
    for (const [key, value] of summaryRows(snapshot.summary)) {
      const v = el('div', 'fields-val');
      v.appendChild(el('span', 'fields-raw', value));
      grid.append(el('div', 'fields-key', key), v);
    }
    container.appendChild(grid);
  }
  const root = snapshot.doc.root;
  if (!root) return;
  const rows: HTMLElement[] = [];
  const walk = (element: XmlElement, path: string, depth: number) => {
    const open = isOpen(element, path, toggled);
    const row = el('div', 'tree-row');
    if (path === selectedPath) row.classList.add('selected');
    row.style.paddingLeft = `${8 + depth * 12}px`;
    const caret = el('span', 'tree-caret', element.children.length ? (open ? '▼' : '▶') : '');
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onToggle(path);
    });
    row.append(caret, el('span', 'mpd-el', element.name), el('span', 'tree-desc', describe(element)), el('span', 'tree-size', `:${element.line}`));
    row.addEventListener('click', () => handlers.onElement(path, element));
    rows.push(row);
    if (!open) return;
    const counts = new Map<string, number>();
    element.children.slice(0, MAX_CHILDREN).forEach((child) => {
      const n = counts.get(child.name) ?? 0;
      counts.set(child.name, n + 1);
      walk(child, `${path}/${child.name}[${n}]`, depth + 1);
    });
    if (element.children.length > MAX_CHILDREN) {
      const more = el('div', 'tree-row mpd-more', `… ${(element.children.length - MAX_CHILDREN).toLocaleString()} more`);
      more.style.paddingLeft = `${8 + (depth + 1) * 12 + 14}px`;
      rows.push(more);
    }
  };
  walk(root, root.name, 0);
  const tree = el('div', 'mpd-tree');
  tree.append(...rows);
  container.appendChild(tree);
}

// ---------- source ----------

export interface SourceView {
  /** Marks the lines of one element and scrolls to them; no arguments clears the mark. */
  highlight(from?: number, to?: number): void;
}

const tokenNode = ([kind, text]: Token): Node => (kind === 'text' ? document.createTextNode(text) : el('span', `x-${kind}`, text));

export function renderMpdSource(container: HTMLElement, entry: MpdEntry | undefined, snapshot: Snapshot | undefined): SourceView {
  container.replaceChildren();
  if (!entry || !snapshot) return { highlight: () => undefined };

  const head = el('div', 'pane-head');
  const url = el('span', 'mono', entry.url);
  url.title = entry.url;
  const allLines = highlightLines(snapshot.text);
  if (allLines.length > 1 && allLines.at(-1)!.length === 0) allLines.pop();
  const seen = snapshot.count > 1 ? ` – ${clock(new Date(snapshot.lastTime))} (×${snapshot.count})` : '';
  head.append(url, el('span', 'mpd-meta', `${snapshot.status ? `${snapshot.status} · ` : ''}${allLines.length.toLocaleString()} lines · ${snapshot.text.length.toLocaleString()} chars · ${clock(new Date(snapshot.time))}${seen}`));
  container.appendChild(head);

  const lineEls: HTMLElement[] = [];
  const jump = (line: number) => lineEls[Math.min(line, lineEls.length) - 1]?.scrollIntoView({ block: 'center' });
  if (snapshot.doc.errors.length) {
    const errors = el('div', 'mpd-errors');
    for (const e of snapshot.doc.errors) {
      const row = el('div', 'mpd-error', `Not well-formed, line ${e.line}: ${e.message}`);
      row.addEventListener('click', () => jump(e.line));
      errors.appendChild(row);
    }
    container.appendChild(errors);
  }

  const lines = allLines.slice(0, MAX_LINES);
  const errorLines = new Set(snapshot.doc.errors.map((e) => e.line));
  const source = el('div', 'mpd-source');
  source.style.setProperty('--digits', String(String(lines.length).length));
  // Lines start as plain text; a block gets its coloured tokens when it comes near the viewport,
  // so a long MPD costs spans only for what is looked at.
  const firstLine = new Map<Element, number>();
  const colour = new IntersectionObserver(
    (hits) => {
      for (const hit of hits) {
        if (!hit.isIntersecting) continue;
        colour.unobserve(hit.target);
        const first = firstLine.get(hit.target) ?? 0;
        hit.target.querySelectorAll('.src-text').forEach((t, k) => t.replaceChildren(...lines[first + k].map(tokenNode)));
      }
    },
    { rootMargin: '300px' },
  );
  for (let i = 0; i < lines.length; i += CHUNK) {
    const chunk = el('div', 'src-chunk');
    for (let j = i; j < Math.min(i + CHUNK, lines.length); j++) {
      const line = el('div', 'src-line');
      if (errorLines.has(j + 1)) line.classList.add('error');
      line.append(el('span', 'src-no', String(j + 1)), el('span', 'src-text', lines[j].map((t) => t[1]).join('')));
      lineEls.push(line);
      chunk.appendChild(line);
    }
    firstLine.set(chunk, i);
    colour.observe(chunk);
    source.appendChild(chunk);
  }
  container.appendChild(source);
  if (allLines.length > MAX_LINES) container.appendChild(el('p', 'mpd-truncated', `Showing the first ${MAX_LINES.toLocaleString()} of ${allLines.length.toLocaleString()} lines.`));

  let marked: HTMLElement[] = [];
  return {
    highlight(from, to) {
      for (const l of marked) l.classList.remove('hl');
      marked = from === undefined ? [] : lineEls.slice(from - 1, to ?? from);
      for (const l of marked) l.classList.add('hl');
      if (from !== undefined) jump(from);
    },
  };
}
