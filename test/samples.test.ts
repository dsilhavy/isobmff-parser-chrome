import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIsoBoxes, type ParsedIsoBox, type TrackRunBox } from '@svta/cml-iso-bmff';
import type { Segment } from '../src/capture';
import { readerConfig } from '../src/readers';
import { av1FrameType, av1ReducedStill, avcSliceType, frameType, hevcFrameType, sampleStats, trunSamples, type SampleInfo } from '../src/samples';

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const bytesOf = (type: string, ...parts: (number[] | Uint8Array)[]): number[] => {
  const payload = parts.flatMap((p) => [...p]);
  return [...u32(8 + payload.length), ...[...type].map((c) => c.charCodeAt(0)), ...payload];
};
const box = (type: string, fields: Record<string, unknown> = {}, boxes?: unknown[]): ParsedIsoBox =>
  ({ type, size: 8, view: { byteOffset: 0 }, ...fields, ...(boxes ? { boxes } : {}) }) as unknown as ParsedIsoBox;
const seg = (bytes: Uint8Array<ArrayBuffer>, boxes: ParsedIsoBox[]): Segment => ({ url: 'https://a/1.m4s', time: new Date(), bytes, boxes });

// moof @ 0: tfhd default-base-is-moof, tfdt 1000, two truns
const tfhd = box('tfhd', { flags: 0x020008, trackId: 1, defaultSampleDuration: 50 });
const trun1 = box('trun', { flags: 0x701, dataOffset: 200, firstSampleFlags: 0x02000000, samples: [{ sampleDuration: 100, sampleSize: 10 }, { sampleDuration: 100, sampleSize: 20, sampleFlags: 0x01010000 }] }) as TrackRunBox & ParsedIsoBox;
const trun2 = box('trun', { flags: 0x000, samples: [{ sampleCompositionTimeOffset: 25 }] }) as TrackRunBox & ParsedIsoBox;
const traf = box('traf', {}, [tfhd, box('tfdt', { baseMediaDecodeTime: 1000 }), trun1, trun2]);
const moof = box('moof', { view: { byteOffset: 0 } }, [traf]);
const segment = seg(new Uint8Array(400), [moof]);

test('trunSamples: dts across truns, defaults from tfhd then trex, first-sample flags', () => {
  const s1 = trunSamples(segment, moof, traf, trun1, { size: 7, flags: 0x01010000 });
  assert.deepEqual(s1.map((s) => [s.index, s.dts, s.pts, s.duration, s.size, s.flags, s.sync]), [
    [0, 1000, 1000, 100, 10, 0x02000000, true],
    [1, 1100, 1100, 100, 20, 0x01010000, false],
  ]);
  const s2 = trunSamples(segment, moof, traf, trun2, { size: 7, flags: 0x01010000 });
  assert.deepEqual(s2.map((s) => [s.index, s.dts, s.pts, s.duration, s.size, s.flags]), [[0, 1200, 1225, 50, 7, 0x01010000]]);
});

test('trunSamples: offsets from moof base + dataOffset, continuing into the next trun; baseDataOffset wins', () => {
  assert.deepEqual(trunSamples(segment, moof, traf, trun1, { size: 7 }).map((s) => s.offset), [200, 210]);
  assert.deepEqual(trunSamples(segment, moof, traf, trun2, { size: 7 }).map((s) => s.offset), [230]);
  const abs = box('traf', {}, [box('tfhd', { flags: 0x1, trackId: 1, baseDataOffset: 5000 }), box('tfdt', { baseMediaDecodeTime: 0 }), trun1]);
  assert.deepEqual(trunSamples(segment, moof, abs, trun1).map((s) => s.offset), [5200, 5210]);
  const sizeless = box('trun', { dataOffset: 200, samples: [{}, {}] }) as TrackRunBox & ParsedIsoBox;
  const t2 = box('traf', {}, [box('tfhd', { flags: 0, trackId: 1 }), sizeless]);
  assert.deepEqual(trunSamples(segment, moof, t2, sizeless).map((s) => s.offset), [200, undefined]);
});

test('frameType: slice type wins, else class from sample flags', () => {
  const s = (flags: number, slice?: SampleInfo['slice']): SampleInfo =>
    ({ index: 0, dts: 0, pts: 0, flags, sync: !(flags & 0x10000), dependsOn: (flags >>> 24) & 3, isDependedOn: (flags >>> 22) & 3, slice }) as SampleInfo;
  assert.equal(frameType(s(0x02000000)), 'I'); // depends_on 2
  assert.equal(frameType(s(0x00000000)), 'I'); // sync bit clear, nothing else known
  assert.equal(frameType(s(0x01010000)), 'P'); // depends on others, non-sync
  assert.equal(frameType(s(0x01810000)), 'B'); // disposable
  assert.equal(frameType(s(0x00010000)), '?');
  assert.equal(frameType(s(0x00010000, 'B')), 'B');
});

test('avcSliceType parses slice_type from the slice header', () => {
  assert.equal(avcSliceType(new Uint8Array([0x65, 0x88])), 'I'); // IDR, first_mb 0, slice_type 7
  assert.equal(avcSliceType(new Uint8Array([0x41, 0xc0])), 'P'); // slice_type 0
  assert.equal(avcSliceType(new Uint8Array([0x41, 0xa0])), 'B'); // slice_type 1
  assert.equal(avcSliceType(new Uint8Array([0x06, 0x05])), undefined); // SEI
});

test('sampleStats: totals, per-type counts, bitrate and fps', () => {
  const samples = trunSamples(segment, moof, traf, trun1, { size: 7 });
  const st = sampleStats(samples, 1000);
  assert.deepEqual([st.count, st.duration, st.bytes, st.sync, st.minSize, st.maxSize], [2, 200, 30, 1, 10, 20]);
  assert.deepEqual(st.types, { I: 1, P: 1 });
  assert.equal(st.secs, 0.2);
  assert.equal(st.kbps, 1.2);
  assert.equal(st.fps, 10);
  assert.equal(sampleStats(samples).secs, undefined);
});

test('end to end: AVC slice types read from mdat through the parsed moof', () => {
  const sample1 = [...u32(2), 0x65, 0x88];
  const sample2 = [...u32(2), 0x41, 0xa0];
  const trun = bytesOf('trun', [0, 0, 0x07, 0x01], u32(2), u32(116), u32(100), u32(6), u32(0x02000000), u32(100), u32(6), u32(0x01010000));
  const trafB = bytesOf('traf', bytesOf('tfhd', [0, 0x02, 0, 0], u32(1)), bytesOf('tfdt', [0, 0, 0, 0], u32(0)), trun);
  const moofB = bytesOf('moof', bytesOf('mfhd', [0, 0, 0, 0], u32(1)), trafB);
  assert.equal(moofB.length, 108);
  const bytes = new Uint8Array([...moofB, ...bytesOf('mdat', sample1, sample2)]);
  const boxes = readIsoBoxes(bytes, readerConfig);
  const m = boxes[0];
  const t = (m as unknown as { boxes: ParsedIsoBox[] }).boxes[1];
  const tr = (t as unknown as { boxes: ParsedIsoBox[] }).boxes[2] as TrackRunBox & ParsedIsoBox;
  const samples = trunSamples(seg(bytes, boxes), m, t, tr, undefined, { kind: 'avc', nalLengthSize: 4 });
  assert.deepEqual(samples.map((s) => [s.offset, s.slice, frameType(s)]), [[116, 'I', 'I'], [122, 'B', 'B']]);
});

test('hevcFrameType: IRAP NAL types 16–23 are key frames, other VCL types stay undecided', () => {
  assert.equal(hevcFrameType(new Uint8Array([19 << 1, 0x01])), 'IRAP'); // IDR_W_RADL
  assert.equal(hevcFrameType(new Uint8Array([21 << 1, 0x01])), 'IRAP'); // CRA
  assert.equal(hevcFrameType(new Uint8Array([1 << 1, 0x01])), undefined); // TRAIL_R
  assert.equal(hevcFrameType(new Uint8Array([39 << 1, 0x01])), undefined); // SEI
});

test('av1FrameType: frame_type from the first OBU_FRAME / OBU_FRAME_HEADER after the temporal delimiter', () => {
  const td = [0x12, 0x00];
  const frame = (bits: number) => new Uint8Array([...td, 0x32, 0x01, bits]); // OBU_FRAME with size field, 1-byte payload
  assert.equal(av1FrameType(frame(0x10), false), 'KEY'); // 0 00 1
  assert.equal(av1FrameType(frame(0x30), false), 'INTER'); // 0 01 1
  assert.equal(av1FrameType(frame(0x50), false), 'INTRA'); // 0 10 1
  assert.equal(av1FrameType(frame(0x70), false), 'SWITCH'); // 0 11 1
  assert.equal(av1FrameType(frame(0x80), false), 'EXISTING'); // show_existing_frame
  assert.equal(av1FrameType(frame(0x70), true), 'KEY'); // reduced_still_picture_header: always KEY
  assert.equal(av1FrameType(new Uint8Array([0x1a, 0x01, 0x70]), false), 'SWITCH'); // OBU_FRAME_HEADER (3) with extension flag? no: 0x1a = type 3, size field
  assert.equal(av1FrameType(new Uint8Array([0x0a, 0x01, 0x18]), false), undefined); // only a sequence header
});

test('av1ReducedStill reads reduced_still_picture_header from the sequence header OBU', () => {
  assert.equal(av1ReducedStill(new Uint8Array([0x0a, 0x01, 0x18])), true); // profile 0, still_picture 1, reduced 1
  assert.equal(av1ReducedStill(new Uint8Array([0x0a, 0x01, 0x00])), false);
  assert.equal(av1ReducedStill(new Uint8Array([])), false);
});

test('trunSamples: codec selects the parser (HEVC by NAL type, AV1 by OBU)', () => {
  const run = (bytes: number[], sizes: number[], codec: Parameters<typeof trunSamples>[5]) => {
    const tr = box('trun', { dataOffset: 0, samples: sizes.map((sampleSize) => ({ sampleSize })) }) as TrackRunBox & ParsedIsoBox;
    const tf = box('traf', {}, [box('tfhd', { flags: 0, trackId: 1 }), tr]);
    return trunSamples(seg(new Uint8Array(bytes), []), box('moof', { view: { byteOffset: 0 } }, [tf]), tf, tr, undefined, codec);
  };
  const nal = (n: number[]) => [...u32(n.length), ...n];
  const h = run([...nal([19 << 1, 1, 0xaf]), ...nal([1 << 1, 1, 0xaf])], [7, 7], { kind: 'hevc', nalLengthSize: 4 });
  assert.deepEqual(h.map((s) => s.slice), ['IRAP', undefined]);
  const a = run([0x12, 0x00, 0x32, 0x01, 0x70, 0x12, 0x00, 0x32, 0x01, 0x30], [5, 5], { kind: 'av1', reducedStill: false });
  assert.deepEqual(a.map((s) => [s.slice, frameType(s)]), [['SWITCH', 'SWITCH'], ['INTER', 'INTER']]);
});
