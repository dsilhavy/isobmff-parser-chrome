import { filterIsoBoxes, isIsoBoxType, traverseIsoBoxes, type IsoBoxMap } from '@svta/cml-iso-bmff';
import type { Segment } from './capture';
import { warningsOf } from './checks';
import { trackCodec } from './codecs';
import { templateOf, type Lane } from './continuity';

export type KindFilter = 'all' | 'init' | 'media' | 'issues';

export interface SegmentMeta {
  kind: string; // 'init' | 'media' | first box type | 'error'
  tracks: Set<number>;
  handlers: Set<string>;
  issue?: 'gap' | 'overlap';
  warnings: string[]; // from checks.ts
  encrypted: boolean; // init: has tenc; media: has senc
}

export interface Group {
  template: string;
  handler?: string;
  codec?: string; // init groups: codec of the first track
  segments: Segment[];
  size: number;
}

export function kindOf(segment: Segment): string {
  const types = new Set(segment.boxes.map((b) => b.type));
  if (types.has('moov')) return 'init';
  if (types.has('moof')) return 'media';
  return segment.boxes[0]?.type ?? 'error';
}

const hdlrs = (boxes: Iterable<unknown>) =>
  filterIsoBoxes(boxes, (b): b is IsoBoxMap['hdlr'] => isIsoBoxType('hdlr', b)).map((h) => h.handlerType);

/** Whether any box of `type` exists anywhere in the tree. */
export function hasBox(boxes: Iterable<unknown>, type: string): boolean {
  for (const b of traverseIsoBoxes(boxes)) if ((b as { type: string }).type === type) return true;
  return false;
}

/** Per-segment facts for filtering and list decoration, derived from the analysed lanes. */
export function metaOf(segments: Segment[], lanes: Lane[]): Map<Segment, SegmentMeta> {
  const meta = new Map<Segment, SegmentMeta>();
  for (const s of segments) {
    const kind = kindOf(s);
    meta.set(s, {
      kind,
      tracks: new Set(),
      handlers: new Set(kind === 'init' ? hdlrs(s.boxes) : []),
      warnings: warningsOf(s),
      encrypted: hasBox(s.boxes, kind === 'init' ? 'tenc' : 'senc'),
    });
  }
  for (const lane of lanes) {
    for (const span of lane.spans) {
      const m = meta.get(span.segment);
      if (!m) continue;
      m.tracks.add(lane.trackId);
      if (lane.handler) m.handlers.add(lane.handler);
      const d = span.deltaBefore;
      if (d !== undefined && d !== 0 && !m.issue) m.issue = d > 0 ? 'gap' : 'overlap';
    }
  }
  return meta;
}

/** Case-insensitive; whitespace-separated terms must all match. `track:N`, `init`/`media`, `gap`/`overlap`/`warn`, `enc`, 4-letter handler codes; else URL substring. */
export function matches(segment: Segment, meta: SegmentMeta, query: string, kind: KindFilter): boolean {
  if (kind === 'issues' ? !meta.issue && !meta.warnings.length : kind !== 'all' && meta.kind !== kind) return false;
  const url = segment.url.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => {
      if (term.startsWith('track:')) return meta.tracks.has(Number(term.slice(6)));
      if (term === 'init' || term === 'media') return meta.kind === term;
      if (term === 'gap' || term === 'overlap') return meta.issue === term;
      if (term === 'warn') return meta.warnings.length > 0;
      if (term === 'enc') return meta.encrypted;
      if (meta.handlers.has(term)) return true;
      return url.includes(term);
    });
}

export function groupSegments(segments: Segment[], meta: Map<Segment, SegmentMeta>): Group[] {
  const groups = new Map<string, Group>();
  for (const s of segments) {
    const template = templateOf(s.url);
    let g = groups.get(template);
    if (!g) groups.set(template, (g = { template, segments: [], size: 0 }));
    g.segments.push(s);
    g.size += s.bytes.byteLength;
    g.handler ??= [...(meta.get(s)?.handlers ?? [])][0];
    g.codec ??= filterIsoBoxes(s.boxes as Iterable<unknown>, (b): b is IsoBoxMap['trak'] => isIsoBoxType('trak', b)).map(trackCodec).find(Boolean);
  }
  return [...groups.values()];
}
