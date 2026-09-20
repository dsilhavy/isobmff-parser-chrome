import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIsoBoxes } from '@svta/cml-iso-bmff';
import { readerConfig } from '../src/readers';

/** Builds a box: 4-byte size, type, payload. */
export function boxBytes(type: string, ...parts: (number[] | Uint8Array)[]): Uint8Array {
  const payload = parts.flatMap((p) => [...p]);
  const size = 8 + payload.length;
  return new Uint8Array([size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...[...type].map((c) => c.charCodeAt(0)), ...payload]);
}
const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const full = (version: number, flags: number) => [version, ...u32(flags).slice(1)];
const parse = (bytes: Uint8Array) => readIsoBoxes(bytes, readerConfig)[0] as unknown as Record<string, unknown>;

test('senc: 8-byte IVs with subsamples', () => {
  const b = parse(boxBytes('senc', full(0, 2), u32(1), [1, 2, 3, 4, 5, 6, 7, 8], u16(2), u16(10), u32(90), u16(5), u32(95)));
  assert.equal(b.ivSize, 8);
  assert.deepEqual(b.samples, [{
    initializationVector: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    subsampleEncryption: [{ bytesOfClearData: 10, bytesOfProtectedData: 90 }, { bytesOfClearData: 5, bytesOfProtectedData: 95 }],
  }]);
});

test('senc: 16-byte IVs without subsamples are recognised by exact fit', () => {
  const iv = Array.from({ length: 16 }, (_, i) => i);
  const b = parse(boxBytes('senc', full(0, 0), u32(2), iv, iv));
  assert.equal(b.ivSize, 16);
  assert.equal((b.samples as unknown[]).length, 2);
});

test('senc: constant IV (cbcs) leaves ivSize 0', () => {
  const b = parse(boxBytes('senc', full(0, 2), u32(1), u16(1), u16(3), u32(7)));
  assert.equal(b.ivSize, 0);
  assert.deepEqual(b.samples, [{ initializationVector: new Uint8Array(0), subsampleEncryption: [{ bytesOfClearData: 3, bytesOfProtectedData: 7 }] }]);
});

test('saiz: default size 0 lists per-sample sizes; flag 1 carries aux info type', () => {
  const b = parse(boxBytes('saiz', full(0, 1), [...'cenc'].map((c) => c.charCodeAt(0)), u32(0), [0], u32(3), [16, 24, 16]));
  assert.equal(b.auxInfoType, 'cenc');
  assert.equal(b.defaultSampleInfoSize, 0);
  assert.deepEqual(b.sampleInfoSize, [16, 24, 16]);
  const c = parse(boxBytes('saiz', full(0, 0), [16], u32(3)));
  assert.equal(c.sampleInfoSize, undefined);
});

test('saio: v1 offsets are 64-bit', () => {
  const b = parse(boxBytes('saio', full(1, 0), u32(1), u32(0), u32(1234)));
  assert.deepEqual(b.offset, [1234]);
  const c = parse(boxBytes('saio', full(0, 0), u32(2), u32(5), u32(6)));
  assert.deepEqual(c.offset, [5, 6]);
});

const str = (s: string) => [...s].map((c) => c.charCodeAt(0));

test('avcC: profile/level, length size, SPS and PPS arrays', () => {
  const sps = [0x67, 0x64, 0x00, 0x1f, 0xac];
  const pps = [0x68, 0xeb, 0xe3, 0xcb];
  const b = parse(boxBytes('avcC', [1, 0x64, 0x00, 0x1f, 0xff], [0xe1], u16(sps.length), sps, [1], u16(pps.length), pps, [0xfd, 0xf8, 0xf8, 0]));
  assert.equal(b.avcProfileIndication, 0x64);
  assert.equal(b.profileCompatibility, 0);
  assert.equal(b.avcLevelIndication, 0x1f);
  assert.equal(b.lengthSizeMinusOne, 3);
  assert.deepEqual(b.sps, [new Uint8Array(sps)]);
  assert.deepEqual(b.pps, [new Uint8Array(pps)]);
  assert.equal(b.chromaFormat, 1);
  assert.equal(b.bitDepthLuma, 8);
});

test('hvcC: general profile fields and NAL arrays', () => {
  const vps = [0x40, 0x01, 0x0c];
  const b = parse(boxBytes('hvcC',
    [1, 0x02 /* space 0, tier 0, idc 2 */], u32(0x20000000), [0x90, 0, 0, 0, 0, 0], [93 /* level */],
    u16(0xf000), [0xfc], [0xfd], [0xf8], [0xf8], u16(0), [0x0f /* len 4 */], [1 /* numArrays */],
    [0xa0 /* type 32 */], u16(1), u16(vps.length), vps,
  ));
  assert.equal(b.generalProfileSpace, 0);
  assert.equal(b.generalTierFlag, 0);
  assert.equal(b.generalProfileIdc, 2);
  assert.equal(b.generalProfileCompatibilityFlags, 0x20000000);
  assert.deepEqual(b.generalConstraintIndicatorFlags, new Uint8Array([0x90, 0, 0, 0, 0, 0]));
  assert.equal(b.generalLevelIdc, 93);
  assert.equal(b.chromaFormatIdc, 1);
  assert.equal(b.bitDepthLumaMinus8, 0);
  assert.equal(b.lengthSizeMinusOne, 3);
  assert.deepEqual(b.arrays, [{ nalUnitType: 32, nalus: [new Uint8Array(vps)] }]);
});

test('av1C: sequence header bits', () => {
  // marker 1 | version 1; seq_profile 0, level 8, tier 0; high_bitdepth 0, twelve 0, mono 0, subx 1, suby 1, pos 0
  const b = parse(boxBytes('av1C', [0x81, 0x08, 0x0c, 0x00], [0x0a, 0x0b]));
  assert.equal(b.seqProfile, 0);
  assert.equal(b.seqLevelIdx0, 8);
  assert.equal(b.seqTier0, 0);
  assert.equal(b.highBitdepth, 0);
  assert.equal(b.monochrome, 0);
  assert.equal(b.chromaSubsamplingX, 1);
  assert.deepEqual(b.configOBUs, new Uint8Array([0x0a, 0x0b]));
});

test('vpcC: profile, level, bit depth and colour fields', () => {
  const b = parse(boxBytes('vpcC', full(1, 0), [0, 31, (8 << 4) | (1 << 1) | 0, 1, 1, 1], u16(0)));
  assert.equal(b.profile, 0);
  assert.equal(b.level, 31);
  assert.equal(b.bitDepth, 8);
  assert.equal(b.chromaSubsampling, 1);
  assert.equal(b.videoFullRangeFlag, 0);
  assert.equal(b.colourPrimaries, 1);
});

test('esds: AAC-LC decoder config and audio specific config', () => {
  // ES_Descriptor(3) { es_id u16, flags u8, DecoderConfig(4) { oti, streamType<<2|1, buffer 3B, max u32, avg u32, DSI(5) { 0x12 0x10 } } }
  const dsi = [0x05, 2, 0x12, 0x10]; // AOT 2, sf index 4 (44100), channels 2
  const dcd = [0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, ...u32(128000), ...u32(128000), ...dsi];
  const es = [0x03, 3 + dcd.length, 0, 1, 0, ...dcd];
  const b = parse(boxBytes('esds', full(0, 0), es));
  assert.equal(b.objectTypeIndication, 0x40);
  assert.equal(b.streamType, 5);
  assert.equal(b.avgBitrate, 128000);
  assert.equal(b.audioObjectType, 2);
  assert.equal(b.samplingFrequencyIndex, 4);
  assert.equal(b.channelConfiguration, 2);
});

test('esds: expandable descriptor sizes (0x80 continuation bytes)', () => {
  const dsi = [0x05, 0x80, 0x80, 0x80, 2, 0x12, 0x10];
  const dcd = [0x04, 0x80, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0), ...dsi];
  const b = parse(boxBytes('esds', full(0, 0), [0x03, 0x80, 0x80, 3 + dcd.length, 0, 1, 0, ...dcd]));
  assert.equal(b.audioObjectType, 2);
});

test('dOps: Opus specific box', () => {
  const b = parse(boxBytes('dOps', [0, 2], u16(312), u32(48000), u16(0), [0]));
  assert.equal(b.outputChannelCount, 2);
  assert.equal(b.preSkip, 312);
  assert.equal(b.inputSampleRate, 48000);
  assert.equal(b.channelMappingFamily, 0);
});

test('config boxes decode as children of a sample entry', () => {
  const avcC = boxBytes('avcC', [1, 0x64, 0x00, 0x1f, 0xff, 0xe0, 0, 0, 0xf8, 0]);
  const entry = boxBytes('avc1', Array(6).fill(0), u16(1), Array(16).fill(0), u16(1920), u16(1080), u32(0x480000), u32(0x480000), u32(0), u16(1), Array(32).fill(0), u16(24), u16(0xffff), avcC);
  const stsd = readIsoBoxes(boxBytes('stsd', full(0, 0), u32(1), entry), readerConfig)[0] as unknown as { entries: { boxes: { type: string; avcProfileIndication?: number }[] }[] };
  assert.equal(stsd.entries[0].boxes[0].type, 'avcC');
  assert.equal(stsd.entries[0].boxes[0].avcProfileIndication, 0x64);
});
