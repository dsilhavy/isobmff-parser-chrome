import type { ParsedIsoBox, TrackFragmentHeaderBox, TrackRunBox } from '@svta/cml-iso-bmff';
import { childrenOf } from './boxes';
import type { Segment } from './capture';

/** AVC slice types, HEVC IRAP, AV1 frame types. */
export type SliceType = 'I' | 'P' | 'B' | 'SI' | 'SP' | 'IRAP' | 'KEY' | 'INTER' | 'INTRA' | 'SWITCH' | 'EXISTING';

/** What the mdat bytes of a sample look like; picks the frame-type parser. */
export type Codec = { kind: 'avc' | 'hevc'; nalLengthSize: number } | { kind: 'av1'; reducedStill: boolean };

export interface SampleInfo {
  index: number;
  dts: number; // ticks: tfdt + Σ previous durations across the traf's truns
  pts: number; // dts + composition time offset
  duration?: number;
  size?: number;
  flags?: number;
  sync: boolean | undefined; // !(flags & 0x10000)
  dependsOn: number; // sample_depends_on: 0 unknown, 1 yes (not I), 2 no (I)
  isDependedOn: number; // sample_is_depended_on: 0 unknown, 1 yes, 2 no (disposable)
  offset?: number; // byte offset in segment.bytes; undefined if unresolvable
  slice?: SliceType; // parsed from mdat (AVC slice_type, HEVC IRAP, AV1 frame_type)
}

/** Fallback sample values, tfhd first then trex. */
export interface Defaults {
  duration?: number;
  size?: number;
  flags?: number;
}

const NON_SYNC = 0x10000;
const SLICE_TYPES: SliceType[] = ['P', 'B', 'I', 'SP', 'SI'];

/** slice_type of an AVC slice NAL (types 1, 5); undefined for other NAL types. Ignores emulation-prevention bytes. */
export function avcSliceType(nal: Uint8Array): SliceType | undefined {
  const type = nal[0] & 31;
  if (type !== 1 && type !== 5) return undefined;
  let bit = 8;
  const read = () => (bit >> 3 < nal.length ? (nal[bit >> 3] >> (7 - (bit++ & 7))) & 1 : (bit++, 0));
  const ue = () => {
    let zeros = 0;
    while (!read() && zeros < 32) zeros++;
    let v = 1;
    for (let i = 0; i < zeros; i++) v = (v << 1) | read();
    return v - 1;
  };
  ue(); // first_mb_in_slice
  return SLICE_TYPES[ue() % 5];
}

/** HEVC: IRAP for NAL types 16–23; other VCL types (0–9) stay undecided (slice_type needs the PPS). */
export function hevcFrameType(nal: Uint8Array): SliceType | undefined {
  const type = (nal[0] >> 1) & 63;
  return type >= 16 && type <= 23 ? 'IRAP' : undefined;
}

/** Walks the OBUs of `data`, yielding [type, payload]. */
function* obus(data: Uint8Array): Generator<[number, Uint8Array]> {
  let pos = 0;
  while (pos < data.length) {
    const h = data[pos++];
    const type = (h >> 3) & 15;
    if (h & 4) pos++; // extension header
    let size = data.length - pos;
    if (h & 2) {
      size = 0;
      for (let i = 0; i < 8 && pos < data.length; i++) {
        const b = data[pos++];
        size += (b & 127) * 2 ** (7 * i);
        if (!(b & 128)) break;
      }
    }
    if (pos + size > data.length) return;
    yield [type, data.subarray(pos, pos + size)];
    pos += size;
  }
}

const AV1_FRAME_TYPES: SliceType[] = ['KEY', 'INTER', 'INTRA', 'SWITCH'];

/** AV1: frame_type of the first OBU_FRAME_HEADER (3) / OBU_FRAME (6); EXISTING for show_existing_frame (a buffered frame is output). */
export function av1FrameType(sample: Uint8Array, reducedStill: boolean): SliceType | undefined {
  for (const [type, p] of obus(sample)) {
    if (type !== 3 && type !== 6) continue;
    if (reducedStill) return 'KEY';
    if (!p.length) return undefined;
    if (p[0] & 0x80) return 'EXISTING'; // show_existing_frame
    return AV1_FRAME_TYPES[(p[0] >> 5) & 3];
  }
  return undefined;
}

/** reduced_still_picture_header of the sequence header OBU in av1C.configOBUs (false if absent). */
export function av1ReducedStill(configOBUs: Uint8Array): boolean {
  for (const [type, p] of obus(configOBUs)) if (type === 1) return !!(p[0] & 0x08); // seq_profile(3) still_picture(1) reduced(1)
  return false;
}

/** Frame type of one sample's mdat bytes according to `codec`. */
function sliceOf(bytes: Uint8Array, offset: number, size: number, codec: Codec): SliceType | undefined {
  const end = offset + size;
  if (end > bytes.length) return undefined;
  if (codec.kind === 'av1') return av1FrameType(bytes.subarray(offset, end), codec.reducedStill);
  const n = codec.nalLengthSize;
  const parse = codec.kind === 'avc' ? avcSliceType : hevcFrameType;
  for (let pos = offset; pos + n <= end; ) {
    let len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[pos + i];
    if (!len || pos + n + len > end) return undefined;
    const t = parse(bytes.subarray(pos + n, pos + n + len));
    if (t) return t;
    pos += n + len;
  }
  return undefined;
}

/**
 * Resolved samples of `trun`, walking the traf's truns in order for decode time and data position.
 * Data base = tfhd.baseDataOffset if present, else the moof's offset (default-base-is-moof and the common case).
 * `codec` enables frame-type parsing from the mdat bytes.
 */
// ponytail: HEVC only tells IRAP vs. not; P/B slice_type needs the PPS (num_extra_slice_header_bits), add when needed
export function trunSamples(
  segment: Segment,
  moof: ParsedIsoBox,
  traf: ParsedIsoBox,
  trun: TrackRunBox,
  trex: Defaults = {},
  codec?: Codec,
): SampleInfo[] {
  const kids = childrenOf(traf);
  const tfhd = kids.find((b) => b.type === 'tfhd') as (TrackFragmentHeaderBox & ParsedIsoBox) | undefined;
  const tfdt = kids.find((b) => b.type === 'tfdt') as { baseMediaDecodeTime: number } | undefined;
  const base = tfhd?.baseDataOffset ?? moof.view.byteOffset;
  const dur = (s: TrackRunBox['samples'][number]) => s.sampleDuration ?? tfhd?.defaultSampleDuration ?? trex.duration;
  const size = (s: TrackRunBox['samples'][number]) => s.sampleSize ?? tfhd?.defaultSampleSize ?? trex.size;

  let dts = tfdt?.baseMediaDecodeTime ?? 0;
  let pos: number | undefined = base;
  for (const t of kids.filter((b) => b.type === 'trun') as (TrackRunBox & ParsedIsoBox)[]) {
    if (t.dataOffset !== undefined) pos = base + t.dataOffset;
    if (t !== trun) {
      for (const s of t.samples) {
        dts += dur(s) ?? 0;
        const sz = size(s);
        pos = pos === undefined || sz === undefined ? undefined : pos + sz;
      }
      continue;
    }
    return t.samples.map((s, index) => {
      const flags = s.sampleFlags ?? (index === 0 ? t.firstSampleFlags : undefined) ?? tfhd?.defaultSampleFlags ?? trex.flags;
      const d = dur(s);
      const sz = size(s);
      const offset = pos;
      const info: SampleInfo = {
        index,
        dts,
        pts: dts + (s.sampleCompositionTimeOffset ?? 0),
        duration: d,
        size: sz,
        flags,
        sync: flags === undefined ? undefined : !(flags & NON_SYNC),
        dependsOn: flags === undefined ? 0 : (flags >>> 24) & 3,
        isDependedOn: flags === undefined ? 0 : (flags >>> 22) & 3,
        offset,
      };
      if (codec && offset !== undefined && sz !== undefined) info.slice = sliceOf(segment.bytes, offset, sz, codec);
      dts += d ?? 0;
      pos = pos === undefined || sz === undefined ? undefined : pos + sz;
      return info;
    });
  }
  return [];
}

/** Hover text per frame type. */
export const FRAME_TYPE_HELP: Record<string, string> = {
  I: 'AVC I slice: intra-coded, no references (slice_type from the slice header)',
  P: 'AVC P slice: predicted from earlier frames — or, from sample flags only: depends on other samples',
  B: 'AVC B slice: bi-predicted — or, from sample flags only: disposable, no other sample depends on it',
  SP: 'AVC SP slice: switching P slice (Extended profile)',
  SI: 'AVC SI slice: switching I slice (Extended profile)',
  IRAP: 'HEVC IRAP: intra random access point (IDR/CRA/BLA NAL type 16–23); other HEVC slices are classified from sample flags',
  KEY: 'AV1 KEY_FRAME: intra-coded, resets all reference buffers; random access point',
  INTER: 'AV1 INTER_FRAME: predicted from up to 7 references (AV1 has no separate P/B); may be hidden (show_frame = 0)',
  INTRA: 'AV1 INTRA_ONLY_FRAME: intra-coded but keeps reference buffers; not a random access point',
  SWITCH: 'AV1 SWITCH_FRAME (S-frame): inter frame usable as a switch point between representations',
  EXISTING: 'AV1 show_existing_frame: no coded data, outputs a frame already in the reference buffer (e.g. a hidden ALTREF)',
  '?': 'Unknown: no parsable frame header and sample flags leave dependencies unspecified',
};

/** Slice type when parsed, else the class the sample flags allow: I (no dependencies / sync), B (disposable), P (depends on others), `?`. */
export function frameType(s: SampleInfo): string {
  if (s.slice) return s.slice;
  if (s.flags === undefined) return '?';
  if (s.dependsOn === 2 || (s.sync && s.dependsOn === 0)) return 'I';
  if (s.isDependedOn === 2) return 'B';
  if (s.dependsOn === 1) return 'P';
  return '?';
}

export interface SampleStats {
  count: number;
  duration: number; // ticks, unresolved samples count as 0
  bytes: number;
  sync: number;
  types: Record<string, number>;
  minSize: number;
  maxSize: number;
  secs?: number;
  kbps?: number;
  fps?: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function sampleStats(samples: SampleInfo[], timescale?: number): SampleStats {
  const sizes = samples.map((s) => s.size ?? 0);
  const st: SampleStats = {
    count: samples.length,
    duration: samples.reduce((a, s) => a + (s.duration ?? 0), 0),
    bytes: sizes.reduce((a, b) => a + b, 0),
    sync: samples.filter((s) => s.sync).length,
    types: {},
    minSize: sizes.length ? Math.min(...sizes) : 0,
    maxSize: sizes.length ? Math.max(...sizes) : 0,
  };
  for (const s of samples) {
    const t = frameType(s);
    st.types[t] = (st.types[t] ?? 0) + 1;
  }
  if (timescale && st.duration) {
    st.secs = st.duration / timescale;
    st.kbps = round1((st.bytes * 8) / st.secs / 1000);
    st.fps = round1(st.count / st.secs);
  }
  return st;
}
