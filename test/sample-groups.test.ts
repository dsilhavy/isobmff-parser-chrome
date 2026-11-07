import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIsoBoxes, type ParsedIsoBox, type TrackRunBox } from '@svta/cml-iso-bmff';
import type { Segment } from '../src/capture';
import { warningsOf } from '../src/checks';
import { segmentKids } from '../src/eme/model';
import { derived } from '../src/field-model';
import { readerConfig } from '../src/readers';
import { groupLabel, initGroups, seigKids, trafGroupWarnings, trafSampleGroups, type SbgpBox, type SgpdBox } from '../src/sample-groups';
import { trunSamples } from '../src/samples';

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const fcc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const bytesOf = (type: string, ...parts: number[][]): number[] => {
  const payload = parts.flat();
  return [...u32(8 + payload.length), ...fcc(type), ...payload];
};
const parse = (bytes: number[]) => readIsoBoxes(new Uint8Array(bytes), readerConfig) as unknown as ParsedIsoBox[];
const children = (b: ParsedIsoBox) => (b as unknown as { boxes: ParsedIsoBox[] }).boxes;

const KID_A = '11111111-2222-3333-4444-555555555555';
const KID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const kidBytes = (k: string) => k.replace(/-/g, '').match(/../g)!.map((h) => parseInt(h, 16));
/** seig entry: reserved, crypt/skip, isProtected, Per_Sample_IV_Size, KID [, constant IV]. */
const seig = (kid: string, ivSize = 8, constantIv?: number[]) => [0, 0x19, 1, ivSize, ...kidBytes(kid), ...(constantIv ? [constantIv.length, ...constantIv] : [])];
const sgpdV1 = (type: string, defaultLength: number, entries: number[][]) =>
  bytesOf('sgpd', [1, 0, 0, 0], fcc(type), u32(defaultLength), u32(entries.length), ...entries.map((e) => (defaultLength ? e : [...u32(e.length), ...e])));
const sbgp = (type: string, runs: [number, number][], parameter?: number) =>
  bytesOf('sbgp', [parameter === undefined ? 0 : 1, 0, 0, 0], fcc(type), parameter === undefined ? [] : u32(parameter), u32(runs.length), ...runs.map(([n, i]) => [...u32(n), ...u32(i)]));
const trun = (n: number) => bytesOf('trun', [0, 0, 0, 0], u32(n)); // no per-sample fields
const tfhd = bytesOf('tfhd', [0, 0x02, 0, 0], u32(1));

test('sgpd v1 seig with default_length: KID, pattern, IV size', () => {
  const [g] = parse(sgpdV1('seig', 20, [seig(KID_A), seig(KID_B, 16)])) as unknown as SgpdBox[];
  assert.equal(g.groupingType, 'seig');
  assert.deepEqual(g.entries.map((e) => [e.kid, e.perSampleIvSize, e.cryptByteBlock, e.skipByteBlock, e.isProtected]), [
    [KID_A, 8, 1, 9, 1],
    [KID_B, 16, 1, 9, 1],
  ]);
});

test('sgpd v1 with per-entry lengths: cbcs constant IV', () => {
  const [g] = parse(sgpdV1('seig', 0, [seig(KID_A, 0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])])) as unknown as SgpdBox[];
  assert.equal(g.entries[0].constantIv, '0102030405060708090a0b0c0d0e0f10');
});

test('sgpd v0 roll (fixed size), v2 default index, and an unknown type kept as hex', () => {
  const [roll] = parse(bytesOf('sgpd', [0, 0, 0, 0], fcc('roll'), u32(2), u16(0xffff), u16(2))) as unknown as SgpdBox[];
  assert.deepEqual(roll.entries, [{ rollDistance: -1 }, { rollDistance: 2 }]);
  const [sap] = parse(bytesOf('sgpd', [2, 0, 0, 0], fcc('sap '), u32(1), u32(1), u32(1), [0x81])) as unknown as SgpdBox[];
  assert.equal(sap.defaultGroupDescriptionIndex, 1);
  assert.deepEqual(sap.entries, [{ dependentFlag: 1, sapType: 1 }]);
  const [x] = parse(sgpdV1('abcd', 3, [[1, 2, 3]])) as unknown as SgpdBox[];
  assert.deepEqual(x.entries, [{ length: 3, data: '010203' }]);
  assert.equal(derived('sapType', 3, undefined), 'open GOP: leading pictures not decodable');
  assert.equal(derived('rollDistance', -1, undefined), '1 sample before must be decoded');
});

test('sbgp v0 and v1 (grouping_type_parameter)', () => {
  const [a] = parse(sbgp('seig', [[3, 0x10001], [2, 1]])) as unknown as SbgpBox[];
  assert.deepEqual(a.entries, [{ sampleCount: 3, groupDescriptionIndex: 0x10001 }, { sampleCount: 2, groupDescriptionIndex: 1 }]);
  const [b] = parse(sbgp('roll', [[1, 1]], 7)) as unknown as SbgpBox[];
  assert.equal(b.groupingTypeParameter, 7);
});

// key rotation: samples 0–2 use the fragment-local KID B, 3–4 the init's KID A; two truns of 3 + 2 samples
const traf = parse(bytesOf('traf', tfhd, trun(3), trun(2), sbgp('seig', [[3, 0x10001], [2, 1]]), sgpdV1('seig', 20, [seig(KID_B)])))[0];
const init = parse(
  bytesOf('moov', bytesOf('trak', bytesOf('tkhd', [0, 0, 0, 0], u32(0), u32(0), u32(1), Array(68).fill(0)), bytesOf('mdia', bytesOf('minf', bytesOf('stbl', sgpdV1('seig', 20, [seig(KID_A)])))))),
);

test('trafSampleGroups: local (> 0x10000) and moov indexes resolve to their entries', () => {
  const moovGroups = initGroups(init, 1);
  assert.equal(moovGroups.length, 1);
  const groups = trafSampleGroups(traf, moovGroups);
  assert.deepEqual(groups.map((g) => g[0]?.entry?.kid), [KID_B, KID_B, KID_B, KID_A, KID_A]);
  assert.equal(groupLabel(groups[0][0]), 'seig aaaaaaaa…');
  // without the init, moov indexes stay unresolved but are still labelled
  assert.equal(groupLabel(trafSampleGroups(traf)[4][0]), 'seig #1');
});

test('trafSampleGroups: samples without sbgp take the sgpd v2 default', () => {
  const t = parse(bytesOf('traf', tfhd, trun(2), bytesOf('sgpd', [2, 0, 0, 0], fcc('sap '), u32(1), u32(0x10001), u32(1), [0x02])))[0];
  assert.deepEqual(trafSampleGroups(t).map((g) => g.map(groupLabel)), [['sap 2'], ['sap 2']]);
});

test('trunSamples: group labels follow the sample index across truns', () => {
  const kids = children(traf);
  const truns = kids.filter((b) => b.type === 'trun') as unknown as (TrackRunBox & ParsedIsoBox)[];
  const moof = { type: 'moof', size: 8, view: { byteOffset: 0 }, boxes: [traf] } as unknown as ParsedIsoBox;
  const segment: Segment = { url: 'https://a/1.m4s', time: new Date(), bytes: new Uint8Array(), boxes: [moof] };
  const second = trunSamples(segment, moof, traf, truns[1], {}, undefined, initGroups(init, 1));
  assert.deepEqual(second.map((s) => s.groups), ['seig 11111111…', 'seig 11111111…']);
  assert.deepEqual(trunSamples(segment, moof, traf, truns[0]).map((s) => s.groups), ['seig aaaaaaaa…', 'seig aaaaaaaa…', 'seig aaaaaaaa…']);
});

test('trafGroupWarnings: sample count mismatch and a dangling fragment-local index', () => {
  assert.deepEqual(trafGroupWarnings(traf), []);
  const bad = parse(bytesOf('traf', tfhd, trun(4), sbgp('seig', [[3, 0x10002]]), sgpdV1('seig', 20, [seig(KID_B)])))[0];
  assert.deepEqual(trafGroupWarnings(bad), ["sbgp 'seig' maps 3 samples, the truns have 4", "sbgp 'seig' refers to fragment-local entry 2, sgpd has 1"]);
  const seg: Segment = { url: 'https://a/1.m4s', time: new Date(), bytes: new Uint8Array(), boxes: parse(bytesOf('moof', bytesOf('traf', tfhd, bytesOf('tfdt', [0, 0, 0, 0], u32(0)), trun(1), sbgp('roll', [[1, 0x10001]])))) };
  assert.deepEqual(warningsOf(seg), ["sbgp 'roll' refers to fragment-local entry 1, no sgpd in the traf"]);
});

test('seig KIDs feed the DRM KID cross-check', () => {
  assert.deepEqual(seigKids([traf]), [KID_B]);
  const kids = segmentKids([{ url: 'seg.m4s', boxes: [traf] }]);
  assert.deepEqual(kids, [{ kid: KID_B, source: 'seig', url: 'seg.m4s' }]);
});
