import { filterIsoBoxes, findIsoBox, isIsoBoxType, type IsoBoxMap } from '@svta/cml-iso-bmff';
import type { Segment } from './capture';
import { trackCodec } from './codecs';

export interface Chunk {
  start: number; // tfdt of this traf, in ticks
  duration?: number;
}

export interface Span {
  segment: Segment;
  start: number; // tfdt of first traf for this track, in ticks
  duration?: number; // sum of sample durations in ticks; undefined if unresolvable
  deltaBefore?: number; // start - previous span end; >0 gap, <0 overlap, undefined if first or previous duration unknown
  chunks?: Chunk[]; // one per traf when the track has several moofs in this segment (CMAF chunks)
  sampleCount: number;
  syncOffsets?: number[]; // ticks from `start` of each sync sample; undefined if any sample's flags are unresolvable
}

export interface Lane {
  key: string;
  template: string;
  trackId: number;
  handler?: string; // 'vide' | 'soun' | ... from hdlr
  timescale?: number; // from mdhd of linked init
  codec?: string; // e.g. 'avc1.64001F', from the first stsd entry of the linked init
  init?: Segment; // linked init segment
  trexDefaults?: { duration?: number; size?: number; flags?: number }; // from trex
  spans: Span[];
}

interface TrackInfo {
  timescale?: number;
  handler?: string;
  codec?: string;
  trexDefaultDuration?: number;
  trexDefaultSize?: number;
  trexDefaultFlags?: number;
  init?: Segment;
}

// Typed wrappers: the library guards narrow poorly through generic Iterable<T>.
const find = <T extends keyof IsoBoxMap>(boxes: Iterable<unknown>, type: T): IsoBoxMap[T] | null =>
  findIsoBox(boxes, (b): b is IsoBoxMap[T] => isIsoBoxType(type, b));
const all = <T extends keyof IsoBoxMap>(boxes: Iterable<unknown>, type: T): IsoBoxMap[T][] =>
  filterIsoBoxes(boxes, (b): b is IsoBoxMap[T] => isIsoBoxType(type, b));

/** URL without query/hash, last digit run in the basename stem (extension excluded) replaced by '#'. */
export function templateOf(url: string): string {
  const clean = url.split(/[?#]/)[0];
  const slash = clean.lastIndexOf('/');
  const base = clean.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return clean.slice(0, slash + 1) + stem.replace(/\d+(?!.*\d)/, '#') + ext;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const hasMoov = (s: Segment) => s.boxes.some((b) => b.type === 'moov');

/** Init segment whose URL shares the longest prefix with `url` beyond the origin; ties -> most recently captured. */
function linkInit(url: string, inits: Segment[]): Segment | undefined {
  let best: Segment | undefined;
  let bestLen = url.indexOf('/', url.indexOf('//') + 2) + 1; // origin incl. slash; a shared host alone proves nothing
  for (const init of inits) {
    const len = commonPrefixLength(url, init.url);
    if (len > bestLen || (len === bestLen && best)) {
      best = init;
      bestLen = len;
    }
  }
  return best;
}

function trackInfo(init: Segment | undefined, trackId: number): TrackInfo {
  if (!init) return {};
  const trak = all(init.boxes, 'trak').find((t) => find([t], 'tkhd')?.trackId === trackId);
  const trex = all(init.boxes, 'trex').find((t) => t.trackId === trackId);
  return {
    timescale: trak ? find([trak], 'mdhd')?.timescale : undefined,
    handler: trak ? find([trak], 'hdlr')?.handlerType : undefined,
    codec: trak ? trackCodec(trak) : undefined,
    trexDefaultDuration: trex?.defaultSampleDuration,
    trexDefaultSize: trex?.defaultSampleSize,
    trexDefaultFlags: trex?.defaultSampleFlags,
    init,
  };
}

const NON_SYNC = 0x10000; // sample_is_non_sync_sample bit of sample_flags

interface Samples {
  duration?: number; // undefined if any sample has no resolvable duration
  count: number;
  syncOffsets?: number[]; // undefined if any sample has no resolvable flags
}

/** Walks the trun samples of `trafs` in order, resolving duration/flags through tfhd and trex defaults. */
function samplesOf(trafs: unknown[], trex: TrackInfo): Samples {
  let total: number | undefined = 0;
  let count = 0;
  let sync: number[] | undefined = [];
  for (const traf of trafs) {
    const tfhd = find([traf], 'tfhd');
    for (const trun of all([traf], 'trun')) {
      trun.samples.forEach((sample, i) => {
        const d = sample.sampleDuration ?? tfhd?.defaultSampleDuration ?? trex.trexDefaultDuration;
        const flags = sample.sampleFlags ?? (i === 0 ? trun.firstSampleFlags : undefined) ?? tfhd?.defaultSampleFlags ?? trex.trexDefaultFlags;
        if (flags === undefined) sync = undefined;
        else if (sync && total !== undefined && !(flags & NON_SYNC)) sync.push(total);
        total = d === undefined || total === undefined ? undefined : total + d;
        count++;
      });
    }
  }
  return { duration: total, count, syncOffsets: total === undefined ? undefined : sync };
}

export function analyze(segments: Segment[]): Lane[] {
  const inits = segments.filter(hasMoov);
  const lanes = new Map<string, Lane>();
  const infos = new Map<string, TrackInfo>();

  for (const segment of segments) {
    const trafs = all(segment.boxes, 'traf');
    if (!trafs.length) continue;
    const template = templateOf(segment.url);

    const byTrack = new Map<number, unknown[]>();
    for (const traf of trafs) {
      const id = find([traf], 'tfhd')?.trackId;
      if (id === undefined) continue;
      byTrack.set(id, [...(byTrack.get(id) ?? []), traf]);
    }

    for (const [trackId, trackTrafs] of byTrack) {
      const key = `${template}#${trackId}`;
      let lane = lanes.get(key);
      if (!lane) {
        const info = trackInfo(linkInit(segment.url, inits), trackId);
        lane = {
          key, template, trackId, handler: info.handler, timescale: info.timescale, codec: info.codec, init: info.init,
          trexDefaults: { duration: info.trexDefaultDuration, size: info.trexDefaultSize, flags: info.trexDefaultFlags },
          spans: [],
        };
        lanes.set(key, lane);
        infos.set(key, info);
      }
      const tfdt = find([trackTrafs[0]], 'tfdt');
      if (!tfdt) continue;
      const info = infos.get(key)!;
      const { duration, count, syncOffsets } = samplesOf(trackTrafs, info);
      const span: Span = { segment, start: tfdt.baseMediaDecodeTime, duration, sampleCount: count, syncOffsets };
      if (trackTrafs.length > 1) {
        span.chunks = trackTrafs.map((traf) => ({
          start: find([traf], 'tfdt')?.baseMediaDecodeTime ?? NaN,
          duration: samplesOf([traf], info).duration,
        }));
      }
      lane.spans.push(span);
    }
  }

  for (const lane of lanes.values()) {
    lane.spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < lane.spans.length; i++) {
      const prev = lane.spans[i - 1];
      if (prev.duration !== undefined) lane.spans[i].deltaBefore = lane.spans[i].start - (prev.start + prev.duration);
    }
  }
  return [...lanes.values()];
}
