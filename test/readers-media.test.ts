import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIsoBoxes } from '@svta/cml-iso-bmff';
import { readerConfig } from '../src/readers';
import { codecString } from '../src/codecs';
import { derived } from '../src/field-model';

type Any = { type: string; [key: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const boxBytes = (type: string, ...parts: (number[] | Uint8Array)[]): Uint8Array => {
  const payload = parts.flatMap((p) => [...p]);
  return new Uint8Array([...u32(8 + payload.length), ...[...type].map((c) => c.charCodeAt(0)), ...payload]);
};
const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const parse = (bytes: Uint8Array) => readIsoBoxes(bytes, readerConfig)[0] as unknown as Any;
/** Packs [value, bitCount] pairs MSB-first, zero-padded to a byte. */
const bits = (...fields: [number, number][]): number[] => {
  const out: number[] = [];
  let acc = 0;
  let n = 0;
  for (const [value, count] of fields) {
    for (let i = count - 1; i >= 0; i--) {
      acc = (acc << 1) | (Math.floor(value / 2 ** i) & 1);
      if (++n === 8) {
        out.push(acc);
        acc = n = 0;
      }
    }
  }
  if (n) out.push(acc << (8 - n));
  return out;
};
const audioEntry = (type: string, ...children: Uint8Array[]) =>
  boxBytes(type, Array(6).fill(0), u16(1), Array(8).fill(0), u16(2), u16(16), u32(0), u32(48000 << 16), ...children);
const visualEntry = (type: string, ...children: Uint8Array[]) =>
  boxBytes(type, Array(6).fill(0), u16(1), Array(16).fill(0), u16(3840), u16(2160), u32(0x480000), u32(0x480000), u32(0), u16(1), Array(32).fill(0), u16(24), u16(0xffff), ...children);
const stsdEntry = (entry: Uint8Array): Any => (parse(boxBytes('stsd', [0, 0, 0, 0], u32(1), entry)).entries as Any[])[0]!;
const childOf = (entry: Any, type: string): Any => (entry.boxes as Any[]).find((b) => b.type === type)!;

test('Opus entry: dOps is now reached and decoded (was opaque before)', () => {
  const entry = stsdEntry(audioEntry('Opus', boxBytes('dOps', [0, 2, 0x01, 0x38, 0, 0, 0xbb, 0x80, 0, 0, 0])));
  assert.equal(childOf(entry, 'dOps').preSkip, 312);
  assert.equal(entry.channelcount, 2);
  assert.equal(codecString(entry), 'opus');
});

test('dac3: 48 kHz 3/2 + LFE at 384 kbit/s', () => {
  const dac3 = parse(boxBytes('dac3', bits([0, 2], [8, 5], [0, 3], [7, 3], [1, 1], [14, 5], [0, 5])));
  assert.deepEqual([dac3.fscod, dac3.bsid, dac3.bsmod, dac3.acmod, dac3.lfeon, dac3.bitRateCode], [0, 8, 0, 7, 1, 14]);
  assert.equal(derived('acmod', 7, undefined), '3/2');
  assert.equal(derived('bitRateCode', 14, undefined), '384 kbit/s');
});

test('ec-3 entry with dec3: substream and Dolby Atmos (JOC) extension', () => {
  const dec3 = boxBytes('dec3', [0x18, 0x00, 0x20, 0x0f, 0x00, 0x01, 0x10]);
  const entry = stsdEntry(audioEntry('ec-3', dec3));
  const d = childOf(entry, 'dec3');
  assert.equal(d.dataRate, 768);
  assert.equal(d.numIndSub, 1);
  assert.deepEqual(d.substreams, [{ fscod: 0, bsid: 16, asvc: 0, bsmod: 0, acmod: 7, lfeon: 1, numDepSub: 0 }]);
  assert.equal(d.flagEc3ExtensionTypeA, 1);
  assert.equal(d.complexityIndexTypeA, 16);
  assert.equal(derived('flagEc3ExtensionTypeA', 1, undefined), 'Dolby Atmos (JOC)');
  assert.equal(codecString(entry), 'ec-3');
});

test('ac-4 entry: dac4 header and codec string from the first presentation', () => {
  const dsi = bits([1, 3], [2, 7], [1, 1], [1, 4], [1, 9], [0, 1], [0, 2], [0, 32], [0xffffffff, 32]); // ends byte-aligned after padding
  const dac4 = boxBytes('dac4', dsi, [1, 10], bits([0, 5], [3, 3]), Array(9).fill(0));
  const entry = stsdEntry(audioEntry('ac-4', dac4));
  const d = childOf(entry, 'dac4');
  assert.equal(d.bitstreamVersion, 2);
  assert.equal(d.nPresentations, 1);
  assert.equal(d.presentationVersion, 1);
  assert.equal(d.mdcompat, 3);
  assert.equal(codecString(entry), 'ac-4.02.01.03');
  assert.equal(codecString(stsdEntry(audioEntry('ac-4'))), 'ac-4');
});

test('dfLa: STREAMINFO of 44.1 kHz stereo 16-bit FLAC', () => {
  const streaminfo = [...u16(4096), ...u16(4096), 0, 0, 0, 0, 0, 0, ...bits([44100, 20], [1, 3], [15, 5], [0, 36]), ...Array(16).fill(0)];
  const entry = stsdEntry(audioEntry('fLaC', boxBytes('dfLa', [0, 0, 0, 0], [0x80, 0, 0, 34], streaminfo)));
  const d = childOf(entry, 'dfLa');
  assert.equal(d.sampleRate, 44100);
  assert.equal(d.channels, 2);
  assert.equal(d.bitsPerSample, 16);
  assert.deepEqual(d.metadataBlocks, [{ type: 0, length: 34 }]);
  assert.equal(codecString(entry), 'flac');
});

test('mhm1 entry: mhaC profile/level in the codec string', () => {
  const entry = stsdEntry(audioEntry('mhm1', boxBytes('mhaC', [1, 0x0d, 6, 0, 2, 0xaa, 0xbb])));
  assert.equal(childOf(entry, 'mhaC').mpegh3daConfig.length, 2);
  assert.equal(codecString(entry), 'mhm1.0x0D');
});

test('dvh1 entry: Dolby Vision profile 5 level 6, colour and HDR boxes', () => {
  const dvcC = boxBytes('dvcC', [1, 0], bits([5, 7], [6, 6], [1, 1], [0, 1], [1, 1], [0, 4], [0, 4]), Array(19).fill(0));
  const colr = boxBytes('colr', [...'nclx'].map((c) => c.charCodeAt(0)), u16(9), u16(16), u16(9), [0x80]);
  const clli = boxBytes('clli', u16(1000), u16(400));
  const mdcv = boxBytes('mdcv', u16(13250), u16(34500), u16(7500), u16(3000), u16(34000), u16(16000), u16(15635), u16(16450), u32(10000000), u32(50));
  const btrt = boxBytes('btrt', u32(0), u32(20_000_000), u32(12_000_000));
  const entry = stsdEntry(visualEntry('dvh1', dvcC, colr, clli, mdcv, btrt, boxBytes('pasp', u32(1), u32(1))));
  const dv = childOf(entry, 'dvcC');
  assert.deepEqual([dv.dvVersionMajor, dv.dvProfile, dv.dvLevel, dv.rpuPresentFlag, dv.elPresentFlag, dv.blPresentFlag], [1, 5, 6, 1, 0, 1]);
  assert.equal(codecString(entry), 'dvh1.05.06');
  const c = childOf(entry, 'colr');
  assert.deepEqual([c.colourType, c.colourPrimaries, c.transferCharacteristics, c.matrixCoefficients, c.fullRangeFlag], ['nclx', 9, 16, 9, 1]);
  assert.equal(derived('transferCharacteristics', 16, undefined), 'PQ (SMPTE ST 2084) · HDR');
  assert.equal(childOf(entry, 'clli').maxContentLightLevel, 1000);
  const m = childOf(entry, 'mdcv');
  assert.deepEqual(m.displayPrimaries[0], { x: 13250, y: 34500 });
  assert.equal(derived('maxDisplayMasteringLuminance', m.maxDisplayMasteringLuminance, undefined), '1000 cd/m²');
  assert.equal(childOf(entry, 'btrt').avgBitrate, 12_000_000);
  assert.deepEqual([childOf(entry, 'pasp').hSpacing, childOf(entry, 'pasp').vSpacing], [1, 1]);
});

test('colr with an ICC profile keeps the profile bytes', () => {
  const c = parse(boxBytes('colr', [...'prof'].map((ch) => ch.charCodeAt(0)), [1, 2, 3]));
  assert.equal(c.colourType, 'prof');
  assert.deepEqual([...c.iccProfile], [1, 2, 3]);
});

test('vvc1 entry: vvcC profile/tier/level', () => {
  const vvcC = boxBytes('vvcC', [0, 0, 0, 0], bits([31, 5], [3, 2], [1, 1], [0, 9], [1, 3], [0, 2], [1, 2], [2, 3], [31, 5], [0, 2], [1, 6], [1, 7], [0, 1], [51, 8], [1, 1], [0, 1], [0, 6]));
  const entry = stsdEntry(visualEntry('vvc1', vvcC));
  const v = childOf(entry, 'vvcC');
  assert.deepEqual([v.lengthSizeMinusOne, v.chromaFormatIdc, v.bitDepthMinus8, v.generalProfileIdc, v.generalLevelIdc], [3, 1, 2, 1, 51]);
  assert.equal(codecString(entry), 'vvc1.1.L51');
});

test('stpp entry: namespace, schema location, MIME types; wvtt entry: child boxes', () => {
  const str = (s: string) => [...new TextEncoder().encode(s), 0];
  const stpp = stsdEntry(boxBytes('stpp', Array(6).fill(0), u16(1), str('http://www.w3.org/ns/ttml'), str(''), str('image/png'), boxBytes('btrt', u32(0), u32(8000), u32(4000))));
  assert.equal(stpp.namespace, 'http://www.w3.org/ns/ttml');
  assert.equal(stpp.schemaLocation, '');
  assert.equal(stpp.auxiliaryMimeTypes, 'image/png');
  assert.equal(childOf(stpp, 'btrt').maxBitrate, 8000);
  const wvtt = stsdEntry(boxBytes('wvtt', Array(6).fill(0), u16(1), boxBytes('vttC', new TextEncoder().encode('WEBVTT'))));
  assert.equal(childOf(wvtt, 'vttC').config, 'WEBVTT');
  assert.equal(codecString(wvtt), 'wvtt');
});

test('chnl v0: stereo defined layout with omitted-channels map', () => {
  const c = parse(boxBytes('chnl', [0, 0, 0, 0], [1, 2], [0, 0, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual([c.version, c.streamStructure, c.definedLayout, c.omittedChannelsMap], [0, 1, 2, 0]);
});

test('encrypted Dolby Vision entry keeps its codec string via sinf/frma', () => {
  const dvcC = boxBytes('dvcC', [1, 0], bits([8, 7], [6, 6], [1, 1], [0, 1], [1, 1], [1, 4], [0, 4]), Array(19).fill(0));
  const sinf = boxBytes('sinf', boxBytes('frma', [...'dvh1'].map((c) => c.charCodeAt(0))));
  const entry = stsdEntry(visualEntry('encv', dvcC, sinf));
  assert.equal(codecString(entry), 'dvh1.08.06');
  assert.equal(derived('dvBlSignalCompatibilityId', 1, undefined), 'HDR10');
});
