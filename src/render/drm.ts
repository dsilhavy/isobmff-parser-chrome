import { binOf, type EmeModel, type FlowItem, type LicenseExchange } from '../eme/model';
import type { Header, PNode } from '../eme/types';
import { kidsIn } from '../eme/types';
import { b64ToBytes, hexUuid, kidString, swapUuid, toHex } from '../eme/bytes';
import { basename, clock, el } from './util';

export interface DrmHandlers {
  onSelect: (id: number | null) => void;
  onKid: (kid: string) => void; // jump to the segment box naming this KID
  kidInSegments: (kid: string) => boolean;
}

const HEX_ROWS = 1024;
const SESSION_HUES = [210, 280, 30, 140, 340, 180, 60];

// ---------- helpers ----------

const field = (v: unknown, k: string): unknown => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined);
/** Short binaries inline (16 B as UUID, ≤ 32 B as hex), longer ones as their size. */
function binText(b64: string): string {
  try {
    const b = b64ToBytes(b64);
    if (b.length === 16) return hexUuid(b);
    if (b.length <= 32) return `0x${toHex(b)}`;
    return `<${b.length.toLocaleString()} B>`;
  } catch {
    return '<binary>';
  }
}

/** JSON for display: binary as `<N B>`, refs as their id. */
const display = (v: unknown): string =>
  JSON.stringify(
    v,
    (_k, x) => {
      if (x && typeof x === 'object' && typeof x.$b64 === 'string') return binText(x.$b64);
      if (x && typeof x === 'object' && typeof x.$ref === 'string') return x.$ref;
      return x;
    },
    2,
  ) ?? 'undefined';

const sessionNo = (ref: string | undefined) => (ref ? Number(ref.split('#')[1]) : 0);
const sessionChip = (ref: string | undefined): HTMLElement | null => {
  if (!ref) return null;
  const n = sessionNo(ref);
  const c = el('span', 'drm-session', `S${n}`);
  c.style.setProperty('--hue', String(SESSION_HUES[(n - 1) % SESSION_HUES.length]));
  c.title = ref;
  return c;
};

function statusCounts(item: FlowItem): string {
  const ks = (field(item.value, 'keyStatuses') as { status: string }[] | undefined) ?? [];
  const counts = new Map<string, number>();
  for (const k of ks) counts.set(k.status, (counts.get(k.status) ?? 0) + 1);
  return [...counts].map(([s, n]) => `${n} ${s}`).join(', ') || 'no keys';
}

function summaryOf(item: FlowItem): string {
  const p = item.payloads[0];
  const size = p ? `${p.bytes.length.toLocaleString()} B` : '';
  switch (item.name) {
    case 'requestMediaKeySystemAccess':
      return `${item.keySystemName}${item.status === 'ok' ? ' → granted' : ''}`;
    case 'createSession':
      return String(item.args[0] ?? 'temporary');
    case 'setMediaKeys':
      return item.args[0] ? display(item.args[0]).replace(/"/g, '') : 'null';
    case 'keystatuseschange':
      return statusCounts(item);
    case 'getStatusForPolicy':
      return `${display(item.args[0]).replace(/\s+/g, ' ')}${item.status === 'ok' ? ` → ${String(item.value)}` : ''}`;
    case 'closed':
      return String(field(item.value, 'reason') ?? '');
    case 'hook installed':
      return String(field(item.value, 'url') ?? '');
    default:
      return [p?.parsed.title, size, item.exchange ? `HTTP ${item.exchange.status}` : ''].filter(Boolean).join(' · ');
  }
}

export function matchesDrm(item: FlowItem, filter: string): boolean {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => {
    if (t === 'error' || t === 'issues') return item.status === 'error' || item.issues.length > 0;
    if (t.startsWith('kid:')) return item.payloads.some((p) => kidsIn(p.parsed.nodes).some((k) => k.replace(/-/g, '').includes(t.slice(4).replace(/-/g, ''))));
    if (t.startsWith('s:') || t.startsWith('session:')) return item.session === `Session#${t.split(':')[1]}`;
    return [item.name, item.target, item.keySystem, item.keySystemName, summaryOf(item)].some((x) => x?.toLowerCase().includes(t));
  });
}

const icon = (item: FlowItem): [string, string] =>
  item.status === 'ok' ? ['✓', 'ok'] : item.status === 'error' ? ['✗', 'bad'] : item.status === 'pending' ? ['…', 'muted'] : ['⚡', 'event'];

// ---------- flow list ----------

export function renderDrmList(container: HTMLElement, model: EmeModel, selected: number | null, filter: string, h: DrmHandlers): number {
  const t0 = model.items[0]?.t ?? 0;
  const rows = model.items.filter((it) => matchesDrm(it, filter));
  container.replaceChildren(
    ...rows.map((it) => {
      const r = el('div', 'drm-row');
      if (it.id === selected) r.classList.add('selected');
      if (it.kind === 'event') r.classList.add('event');
      const [glyph, cls] = icon(it);
      r.append(el('span', 'drm-time', `+${((it.t - t0) / 1000).toFixed(3)}`), el('span', `drm-icon ${cls}`, glyph), el('span', 'drm-name', it.kind === 'call' ? `${it.name}()` : it.name));
      const chip = sessionChip(it.session);
      if (chip) r.appendChild(chip);
      else if (it.target) r.appendChild(el('span', 'drm-target', it.target));
      r.appendChild(el('span', 'drm-summary', summaryOf(it)));
      if (it.issues.length) r.appendChild(el('span', 'seg-error', '!'));
      if (it.end !== undefined) r.appendChild(el('span', 'drm-dur', `${Math.round(it.end - it.t)} ms`));
      r.title = [`${it.name} · ${it.target ?? ''} · ${clock(new Date(it.t))}`, ...it.issues].join('\n');
      r.addEventListener('click', () => h.onSelect(it.id === selected ? null : it.id));
      return r;
    }),
  );
  return rows.length;
}

// ---------- detail ----------

function grid(rows: [string, string | Node | undefined][]): HTMLElement {
  const g = el('div', 'fields-grid');
  for (const [k, v] of rows) {
    if (v === undefined) continue;
    const val = el('div', 'fields-val');
    if (typeof v === 'string') val.appendChild(el('span', 'fields-raw', v));
    else val.appendChild(v);
    g.append(el('div', 'fields-key', k), val);
  }
  return g;
}

function kidLink(kid: string, h: DrmHandlers): HTMLElement {
  const known = h.kidInSegments(kid);
  const a = el('button', `drm-kid${known ? '' : ' unknown'}`, kid);
  a.title = known ? 'show the segment box that names this KID' : 'KID not found in captured segments';
  a.addEventListener('click', (e) => {
    e.stopPropagation();
    h.onKid(kid);
  });
  return a;
}

function nodeTree(nodes: PNode[], h: DrmHandlers, depth = 0): HTMLElement {
  const wrap = el('div', 'pn');
  for (const n of nodes) {
    const line = el('span', 'pn-line');
    line.appendChild(el('span', 'pn-label', n.label));
    if (n.kid) line.appendChild(kidLink(n.kid, h));
    if (n.value !== undefined && n.value !== n.kid) line.appendChild(el('span', 'pn-value', n.value));
    if (n.warn) line.appendChild(el('span', 'pn-warn', n.warn));
    if (n.children?.length) {
      const d = document.createElement('details');
      d.open = depth < 2 || n.children.length <= 4;
      const s = document.createElement('summary');
      s.appendChild(line);
      d.append(s, nodeTree(n.children, h, depth + 1));
      wrap.appendChild(d);
    } else {
      const row = el('div', 'pn-leaf');
      row.appendChild(line);
      wrap.appendChild(row);
    }
  }
  return wrap;
}

function headerTable(headers: Header[]): HTMLElement {
  return grid(headers.map((x) => [x.name, x.value]));
}

function issuesBlock(issues: string[]): HTMLElement | null {
  if (!issues.length) return null;
  const ul = el('ul', 'drm-issues');
  for (const i of issues) ul.appendChild(el('li', '', i));
  return ul;
}

function hexButton(label: string, title: string, bytes: Uint8Array | undefined, hexEl: HTMLElement): HTMLElement | null {
  if (!bytes?.length) return null;
  const b = el('button', 'more', label);
  b.addEventListener('click', () => renderBytesHex(hexEl, title, bytes));
  return b;
}

function exchangeBlock(x: LicenseExchange, hexEl: HTMLElement): DocumentFragment {
  const f = document.createDocumentFragment();
  f.appendChild(el('h3', '', `License server exchange · ${x.matched === 'bytes' ? 'matched by body' : 'matched by timing'}`));
  const status = el('span', x.status >= 400 || x.status === 0 ? 'bad' : 'ok', `${x.status} ${x.statusText}`);
  f.appendChild(grid([['url', x.url], ['method', x.method], ['status', status], ['duration', `${Math.round(x.duration)} ms`], ['response type', x.mimeType]]));
  if (x.responseLossy) f.appendChild(el('p', 'muted', `DevTools delivered this binary response as text (${x.mimeType ?? 'no type'}), so its bytes are not recoverable. The update() payload above is the exact license.`));
  for (const [label, headers] of [['request headers', x.requestHeaders], ['response headers', x.responseHeaders]] as const) {
    const d = document.createElement('details');
    d.appendChild(el('summary', 'drm-sub', `${label} (${headers.length})`));
    d.appendChild(headerTable(headers));
    f.appendChild(d);
  }
  const btns = el('div', 'drm-buttons');
  for (const b of [hexButton('request body → hex', `request body · ${basename(x.url)}`, x.requestBody, hexEl), hexButton('response body → hex', `response body · ${basename(x.url)}`, x.responseBody, hexEl)]) if (b) btns.appendChild(b);
  f.appendChild(btns);
  return f;
}

function itemDetail(container: HTMLElement, hexEl: HTMLElement, item: FlowItem, model: EmeModel, h: DrmHandlers): void {
  const head = el('div', 'pane-head fields-head');
  const [glyph, cls] = icon(item);
  head.append(el('span', `drm-icon ${cls}`, glyph), el('span', 'fields-type', item.kind === 'call' ? `${item.name}()` : item.name), el('span', 'fields-name', item.target ?? ''));
  if (item.keySystem) head.appendChild(el('span', 'fields-codec', item.keySystem));
  const back = el('button', 'tree-collapse-all', '× overview');
  back.addEventListener('click', () => h.onSelect(null));
  head.appendChild(back);
  const content = el('div', 'fields-content');
  const issues = issuesBlock(item.issues);
  if (issues) content.appendChild(issues);

  const session = model.sessions.find((s) => s.ref === item.session);
  content.appendChild(
    grid([
      ['time', `${clock(new Date(item.t))}.${String(Math.floor(item.t % 1000)).padStart(3, '0')}`],
      ['duration', item.end !== undefined ? `${(item.end - item.t).toFixed(1)} ms` : item.status === 'pending' ? 'pending' : undefined],
      ['key system', item.keySystemName],
      ['session', session ? `${session.ref}${session.sessionId ? ` · ${session.sessionId}` : ''} · ${session.sessionType}` : undefined],
      ['error', item.error ? `${item.error.name}: ${item.error.message}` : undefined],
    ]),
  );
  if (item.args.length) {
    content.appendChild(el('h3', '', 'arguments'));
    content.appendChild(el('pre', 'drm-json', display(item.args)));
  }
  if (item.name === 'keystatuseschange') content.appendChild(keyStatusTable(item, model, h));
  if (item.value !== undefined && item.value !== null) {
    const title = item.kind === 'event' ? 'event data' : 'result';
    const pre = el('pre', 'drm-json', display(item.value));
    if (item.name === 'keystatuseschange') {
      const d = document.createElement('details');
      d.append(el('summary', 'drm-sub', `raw ${title}`), pre);
      content.appendChild(d);
    } else {
      content.append(el('h3', '', title), pre);
    }
  }
  for (const p of item.payloads) {
    const h3 = el('h3', '', `${p.label} · ${p.parsed.title}`);
    const btn = hexButton('hex', `${p.label} · ${item.name}`, p.bytes, hexEl);
    if (btn) h3.appendChild(btn);
    content.appendChild(h3);
    const w = issuesBlock(p.parsed.warnings);
    if (w) content.appendChild(w);
    if (p.parsed.nodes.length) content.appendChild(nodeTree(p.parsed.nodes, h));
    if (p.parsed.text) {
      const d = document.createElement('details');
      d.appendChild(el('summary', 'drm-sub', 'decoded text'));
      d.appendChild(el('pre', 'drm-json', p.parsed.text));
      content.appendChild(d);
    }
  }
  if (item.exchange) content.appendChild(exchangeBlock(item.exchange, hexEl));
  container.replaceChildren(head, content);
  const first = item.payloads[0];
  if (first) renderBytesHex(hexEl, `${first.label} · ${item.name}`, first.bytes);
  else hexEl.replaceChildren();
}

interface LicenseKey {
  track?: string;
  type?: string;
  level?: string;
}

/** KID → what the license says about it (track label, key type, security level), from every decoded update() payload. */
function licenseKeys(model: EmeModel): Map<string, LicenseKey> {
  const out = new Map<string, LicenseKey>();
  const strip = (v: string | undefined) => v?.replace(/ \(\d+\)$/, '').replace(/^"|"$/g, '');
  const walk = (nodes: PNode[]) => {
    for (const n of nodes) {
      const kids = n.children?.filter((c) => c.kid) ?? [];
      if (kids.length === 1) {
        const c = (re: RegExp) => strip(n.children!.find((x) => re.test(x.label))?.value);
        out.set(kids[0].kid!, { track: c(/^track_label$/), type: c(/^type$/), level: c(/^(level|SecurityLevel)$/) ?? c(/^cipher$/) });
      }
      if (n.children) walk(n.children);
    }
  };
  for (const it of model.items) for (const p of it.payloads) if (p.role === 'update') walk(p.parsed.nodes);
  return out;
}

const STATUS_CLASS: Record<string, string> = { usable: 'ok', 'status-pending': 'muted', released: 'muted', 'output-downscaled': 'warn', 'usable-in-future': 'warn' };

function keyStatusTable(item: FlowItem, model: EmeModel, h: DrmHandlers): DocumentFragment {
  const f = document.createDocumentFragment();
  const statuses = (field(item.value, 'keyStatuses') as { kid: unknown; status: string }[] | undefined) ?? [];
  const exp = field(item.value, 'expiration');
  const expText = typeof exp === 'number' && Number.isFinite(exp) ? new Date(exp).toISOString() : 'none';
  f.appendChild(el('h3', '', `key statuses · ${statuses.length} key${statuses.length === 1 ? '' : 's'} · expiration ${expText}`));
  if (!statuses.length) {
    f.appendChild(el('p', 'muted', 'no keys in this session'));
    return f;
  }
  const lic = licenseKeys(model);
  f.appendChild(
    table(
      ['KID', 'status', 'track', 'key type', 'security / cipher'],
      statuses.map((k) => {
        const raw = kidString(binOf(k.kid) ?? new Uint8Array());
        const kid = lic.has(raw) || !lic.has(swapUuid(raw)) ? raw : swapUuid(raw);
        const key = lic.get(kid);
        const first = key ? (key.track ?? '—') + (kid === raw ? '' : ' (KID in GUID byte order)') : lic.size ? '✗ not in any decoded license' : '—';
        return [kidLink(kid, h), el('span', STATUS_CLASS[k.status] ?? 'bad', k.status), first, key?.type ?? '', key?.level ?? ''];
      }),
    ),
  );
  return f;
}

function table(head: string[], rows: (string | Node)[][]): HTMLElement {
  const wrap = el('div', 'sample-table');
  const t = document.createElement('table');
  const hr = t.createTHead().insertRow();
  for (const c of head) hr.appendChild(el('th', '', c));
  const body = t.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    for (const c of r) {
      const td = tr.insertCell();
      if (typeof c === 'string') td.textContent = c;
      else td.appendChild(c);
    }
  }
  wrap.appendChild(t);
  return wrap;
}

function overview(container: HTMLElement, hexEl: HTMLElement, model: EmeModel, armed: boolean, h: DrmHandlers): void {
  const head = el('div', 'pane-head fields-head');
  head.append(el('span', 'fields-type', 'DRM overview'), el('span', 'fields-name', `${model.sessions.length} session${model.sessions.length === 1 ? '' : 's'} · ${model.kids.length} KID${model.kids.length === 1 ? '' : 's'}`));
  const content = el('div', 'fields-content');
  if (!model.items.length) {
    content.appendChild(
      el(
        'p',
        'muted',
        armed
          ? 'Hook active, no EME calls yet. Start playback of a protected stream.'
          : 'EME calls are only visible when the page runs with the hook. Click “Reload & capture EME”: the page reloads with the hook injected before any page script.',
      ),
    );
  }
  const itemIssues = model.items.filter((i) => i.issues.length).length;
  const all = [...model.issues, ...(itemIssues ? [`${itemIssues} flow item${itemIssues === 1 ? '' : 's'} with issues (filter: error)`] : [])];
  const issues = issuesBlock(all);
  if (issues) content.appendChild(issues);

  const systems = model.items.filter((i) => i.name === 'requestMediaKeySystemAccess');
  if (systems.length) {
    content.appendChild(el('h3', '', 'key system access'));
    content.appendChild(
      table(
        ['key system', 'result', 'robustness (granted)'],
        systems.map((s) => {
          const conf = field(s.value, 'configuration');
          const caps = [...((field(conf, 'videoCapabilities') as unknown[]) ?? []), ...((field(conf, 'audioCapabilities') as unknown[]) ?? [])];
          const rob = [...new Set(caps.map((c) => String(field(c, 'robustness') || '∅')))].join(', ');
          return [s.keySystemName ?? '', s.status === 'ok' ? 'granted' : s.status === 'error' ? `${s.error?.name}` : s.status, s.status === 'ok' ? rob : ''];
        }),
      ),
    );
  }
  if (model.sessions.length) {
    content.appendChild(el('h3', '', 'sessions'));
    content.appendChild(
      table(
        ['', 'key system', 'type', 'sessionId', 'keys', 'expiration', 'closed'],
        model.sessions.map((s) => [
          sessionChip(s.ref) ?? '',
          s.keySystem ?? '?',
          s.sessionType,
          s.sessionId ?? '',
          s.keyStatuses.map((k) => k.status).join(', ') || '—',
          s.expiration && Number.isFinite(s.expiration) ? new Date(s.expiration).toISOString() : '—',
          s.closed ?? '',
        ]),
      ),
    );
  }
  if (model.kids.length) {
    content.appendChild(el('h3', '', 'key IDs'));
    content.appendChild(table(['KID', 'seen in', 'status', 'segments'], model.kids.map((k) => [kidLink(k.kid, h), k.sources.join(', '), k.status ?? '—', k.urls.map(basename).join(', ')])));
  }
  container.replaceChildren(head, content);
  hexEl.replaceChildren();
}

export function renderDrmDetail(container: HTMLElement, hexEl: HTMLElement, model: EmeModel, selected: number | null, armed: boolean, h: DrmHandlers): void {
  const item = selected === null ? undefined : model.items.find((i) => i.id === selected);
  if (item) itemDetail(container, hexEl, item, model, h);
  else overview(container, hexEl, model, armed, h);
}

// ---------- hex ----------

export function renderBytesHex(container: HTMLElement, title: string, bytes: Uint8Array): void {
  const head = el('div', 'pane-head hex-head');
  head.append(el('span', 'hex-title', 'Hex'), el('span', '', `${title} · ${bytes.length.toLocaleString()} B`));
  const pre = el('pre', 'drm-hex');
  const rows = (to: number) => {
    const lines: string[] = [];
    for (let off = 0; off < Math.min(bytes.length, to * 16); off += 16) {
      const chunk = bytes.subarray(off, off + 16);
      const hex = toHex(chunk).replace(/(..)/g, '$1 ').padEnd(48, ' ');
      const ascii = Array.from(chunk, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
      lines.push(`${off.toString(16).padStart(8, '0')}  ${hex} ${ascii}`);
    }
    pre.textContent = lines.join('\n');
  };
  rows(HEX_ROWS);
  container.replaceChildren(head, pre);
  if (bytes.length > HEX_ROWS * 16) {
    const more = el('button', 'more', `Show all ${bytes.length.toLocaleString()} B`);
    more.addEventListener('click', () => {
      rows(Infinity);
      more.remove();
    });
    container.appendChild(more);
  }
}

// ---------- sequence strip ----------

const LANES = ['App', 'Browser / CDM', 'License server'];
const COL = 16;
const LANE_H = 22;
const SVG_NS = 'http://www.w3.org/2000/svg';

interface Arrow {
  id: number;
  from: number;
  to: number;
  cls: string;
  title: string;
}

function arrows(model: EmeModel): Arrow[] {
  const out: Arrow[] = [];
  for (const it of model.items) {
    if (it.name === 'hook installed') continue;
    const cls = it.status === 'error' ? 'bad' : it.issues.length ? 'warn' : it.kind === 'event' ? 'event' : 'call';
    const title = `${it.kind === 'call' ? `${it.name}()` : it.name} ${it.target ?? ''}\n${summaryOf(it)}${it.issues.length ? `\n! ${it.issues.join('\n! ')}` : ''}`;
    out.push({ id: it.id, from: it.kind === 'call' ? 0 : 1, to: it.kind === 'call' ? 1 : 0, cls, title });
    if (it.name === 'message' && it.exchange) {
      const x = it.exchange;
      const bad = x.status >= 400 || x.status === 0 ? 'bad' : 'net';
      out.push({ id: it.id, from: 0, to: 2, cls: bad, title: `POST ${x.url}` });
      out.push({ id: it.id, from: 2, to: 0, cls: bad, title: `HTTP ${x.status} ${x.statusText} · ${x.responseBody?.length ?? 0} B` });
    }
  }
  return out;
}

export function renderDrmSequence(container: HTMLElement, summary: HTMLElement, model: EmeModel, selected: number | null, h: DrmHandlers): void {
  const list = arrows(model);
  const calls = model.items.filter((i) => i.kind === 'call').length;
  const evts = model.items.filter((i) => i.kind === 'event' && i.name !== 'hook installed').length;
  const exchanges = model.items.filter((i) => i.name === 'message' && i.exchange).length;
  const issues = model.issues.length + model.items.filter((i) => i.issues.length).length;
  summary.replaceChildren(el('span', 'tl-caret'), el('span', 'tl-title', 'EME sequence'), el('span', '', `${calls} calls · ${evts} events · ${exchanges} license exchanges`));
  if (issues) summary.appendChild(el('span', 'tl-chip gap', `${issues} issue${issues === 1 ? '' : 's'}`));

  const labels = el('div', 'seq-labels');
  for (const l of LANES) labels.appendChild(el('div', 'seq-label', l));
  const width = Math.max(1, list.length) * COL + COL;
  const height = LANES.length * LANE_H;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.classList.add('seq-svg');
  const mk = (tag: string, attrs: Record<string, string | number>) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  LANES.forEach((_, i) => svg.appendChild(mk('line', { x1: 0, x2: width, y1: i * LANE_H + LANE_H / 2, y2: i * LANE_H + LANE_H / 2, class: 'seq-lane' })));
  list.forEach((a, i) => {
    const x = COL + i * COL;
    const y1 = a.from * LANE_H + LANE_H / 2;
    const y2 = a.to * LANE_H + LANE_H / 2;
    const g = mk('g', { class: `seq-arrow ${a.cls}${a.id === selected ? ' selected' : ''}` });
    g.appendChild(mk('rect', { x: x - COL / 2, y: 0, width: COL, height, class: 'seq-hit' }));
    const dir = y2 > y1 ? 1 : -1;
    g.appendChild(mk('line', { x1: x, x2: x, y1, y2: y2 - dir * 4 }));
    g.appendChild(mk('polygon', { points: `${x - 3},${y2 - dir * 5} ${x + 3},${y2 - dir * 5} ${x},${y2}` }));
    g.appendChild(mk('circle', { cx: x, cy: y1, r: 2 }));
    const t = mk('title', {});
    t.textContent = a.title;
    g.appendChild(t);
    g.addEventListener('click', () => h.onSelect(a.id));
    svg.appendChild(g);
  });
  const scroller = el('div', 'seq-scroll');
  scroller.appendChild(svg);
  const wrap = el('div', 'seq');
  wrap.append(labels, scroller);
  container.replaceChildren(wrap);
  if (!list.length) container.appendChild(el('p', 'muted seq-empty', 'No EME activity captured yet.'));
  const sel = list.findIndex((a) => a.id === selected);
  if (sel >= 0) scroller.scrollLeft = Math.max(0, COL + sel * COL - scroller.clientWidth / 2);
  else scroller.scrollLeft = scroller.scrollWidth;
}
