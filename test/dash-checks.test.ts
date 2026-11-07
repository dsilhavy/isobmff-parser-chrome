import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIsoBoxes, type ParsedIsoBox } from '@svta/cml-iso-bmff';
import type { Segment } from '../src/capture';
import { dashWarnings, isLastSegment } from '../src/dash-checks';
import { matches, metaOf } from '../src/list-model';
import { readerConfig } from '../src/readers';

const box = (type: string, fields: Record<string, unknown> = {}, boxes?: unknown[]): ParsedIsoBox =>
  ({ type, size: 8, ...fields, ...(boxes ? { boxes } : {}) }) as unknown as ParsedIsoBox;
const seg = (boxes: ParsedIsoBox[], bytes = 0, error?: string): Segment => ({ url: 'https://a/v/seg_1.m4s', time: new Date(), bytes: new Uint8Array(bytes), boxes, error });
const styp = (...brands: string[]) => box('styp', { majorBrand: 'msdh', compatibleBrands: brands });
const traf = (tfhdFlags = 0x020000, trunFlags = 1) => box('traf', {}, [box('tfhd', { flags: tfhdFlags }), box('tfdt'), box('trun', { flags: trunFlags, samples: [] })]);
const moof = (t: ParsedIsoBox[] = [traf()]) => box('moof', {}, t);
const mdat = (size = 8) => box('mdat', { size });
const sidx = (firstOffset: number, sizes: number[], size = 44) => box('sidx', { size, firstOffset, references: sizes.map((referencedSize) => ({ referencedSize })) });

test('a conformant simple media segment has no DASH warnings', () => {
  assert.deepEqual(dashWarnings(seg([styp('msdh', 'msix'), sidx(0, [16]), box('prft'), box('emsg'), moof(), mdat()], 8 + 44 + 16)), []);
});

test('6.3.5.2: moof-relative addressing, data offset, traf present', () => {
  assert.deepEqual(dashWarnings(seg([moof([traf(0x000001)]), mdat()])), ["DASH 6.3.5.2: 'tfhd' uses base-data-offset (absolute addressing)"]);
  assert.deepEqual(dashWarnings(seg([moof([traf(0)]), mdat()])), ["DASH 6.3.5.2: 'tfhd' without default-base-is-moof"]);
  assert.deepEqual(dashWarnings(seg([moof([traf(0x020000, 0)]), mdat()])), ["DASH 6.3.5.2: 'trun' without data-offset"]);
  assert.deepEqual(dashWarnings(seg([moof([]), mdat()])), ["DASH 6.3.5.2: 'moof' without 'traf'"]);
});

test('6.3.2.1: every moof has its mdat before the next moof (CMAF chunks pass)', () => {
  assert.deepEqual(dashWarnings(seg([moof(), mdat(), moof(), mdat()])), []);
  assert.deepEqual(dashWarnings(seg([moof(), moof(), mdat()])), ["DASH 6.3.2.1: 'moof' not followed by an 'mdat' before the next 'moof'"]);
});

test('6.3.5.3: box order of styp, prft and emsg', () => {
  assert.deepEqual(dashWarnings(seg([box('prft'), styp(), moof(), mdat()])), ["DASH 6.3.5.3: 'styp' is not the first box", "DASH 6.3.5.3: 'prft' before 'styp'"]);
  assert.deepEqual(dashWarnings(seg([styp(), box('prft'), box('prft'), moof(), mdat()])), ["DASH 6.3.5.3: 2 'prft' boxes (at most one)"]);
  assert.deepEqual(dashWarnings(seg([styp(), moof(), mdat(), box('emsg')])), ["DASH 6.3.5.3: 'emsg' after the last 'mdat'"]);
});

test('6.3.5.3: the first sidx precedes the first moof and documents the whole segment', () => {
  assert.deepEqual(dashWarnings(seg([moof(), mdat(), sidx(0, [16])], 60)), ["DASH 6.3.5.3: first 'sidx' after the first 'moof'"]);
  assert.deepEqual(dashWarnings(seg([sidx(0, [10]), moof(), mdat()], 44 + 16)), ["DASH 6.3.5.3: first 'sidx' documents 54 of 60 bytes"]);
  // a byte-range capture of an on-demand file: the sidx documents more than was downloaded
  assert.deepEqual(dashWarnings(seg([sidx(0, [5000]), moof(), mdat()], 44 + 16)), []);
});

test('6.3.5.4/6.3.5.5: msix and sims brands require sidx, adjacent mdat and ssix', () => {
  assert.deepEqual(dashWarnings(seg([styp('msix'), moof(), mdat()])), ["DASH 6.3.5.4: 'msix' segment without a 'sidx' before the first 'moof'"]);
  assert.deepEqual(dashWarnings(seg([styp('msix'), sidx(0, [24]), moof(), box('free'), mdat()], 8 + 44 + 24)), ["DASH 6.3.5.4: 'msix' segment with a 'moof' not immediately followed by its 'mdat'"]);
  assert.deepEqual(dashWarnings(seg([styp('sims'), sidx(0, [16]), moof(), mdat()], 8 + 44 + 16)), ["DASH 6.3.5.5: 'sims' segment without 'ssix'"]);
  assert.deepEqual(dashWarnings(seg([styp('sims'), sidx(16, [16]), box('free'), box('ssix'), moof(), mdat()], 8 + 44 + 8 + 8 + 16)), ["DASH 6.3.5.5: 'ssix' does not immediately follow a 'sidx'"]);
  assert.deepEqual(dashWarnings(seg([styp('sims'), sidx(8, [16]), box('ssix'), moof(), mdat()], 8 + 44 + 8 + 16)), []);
});

test('6.3.4: init needs ftyp and mvex, and empty sample tables (read from real bytes)', () => {
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const b = (type: string, ...parts: number[][]) => {
    const p = parts.flat();
    return [...u32(8 + p.length), ...[...type].map((c) => c.charCodeAt(0)), ...p];
  };
  const full = [0, 0, 0, 0];
  const stbl = (n: number) =>
    b('stbl', b('stts', full, u32(n), ...Array(n).fill([...u32(1), ...u32(1)])), b('stsc', full, u32(n), ...Array(n).fill([...u32(1), ...u32(1), ...u32(1)])), b('stco', full, u32(n), ...Array(n).fill(u32(100))), b('stsz', full, u32(0), u32(n), ...Array(n).fill(u32(10))));
  const init = (n: number, mvex: boolean) => readIsoBoxes(new Uint8Array([...b('ftyp', [...'iso6'].map((c) => c.charCodeAt(0)), u32(0)), ...b('moov', mvex ? b('mvex') : [], b('trak', b('mdia', b('minf', stbl(n)))))]), readerConfig) as unknown as ParsedIsoBox[];
  assert.deepEqual(dashWarnings(seg(init(0, true))), []);
  assert.deepEqual(dashWarnings(seg(init(2, false))), [
    "DASH 6.3.4: 'moov' without 'mvex' (no movie fragments announced)",
    "DASH 6.3.4: 'stts' in the Initialization Segment has 2 entries (shall be empty)",
    "DASH 6.3.4: 'stsc' in the Initialization Segment has 2 entries (shall be empty)",
    "DASH 6.3.4: 'stco' in the Initialization Segment has 2 entries (shall be empty)",
    "DASH 6.3.4: 'stsz' in the Initialization Segment has 2 samples (shall be empty)",
  ]);
  assert.deepEqual(dashWarnings(seg([box('moov', {}, [box('mvex')])])), ["DASH 6.3.4: Initialization Segment without 'ftyp'"]);
});

test('parse errors and index-only captures are not checked', () => {
  assert.deepEqual(dashWarnings(seg([moof([])], 0, 'boom')), []);
  assert.deepEqual(dashWarnings(seg([sidx(0, [100])], 44)), []);
});

test('filter keywords: dash (DASH warnings) and lmsg (last segment brand)', () => {
  const last = seg([styp('msdh', 'lmsg'), moof(), mdat()]);
  const broken = seg([moof([traf(0)]), mdat()]);
  const meta = metaOf([last, broken], []);
  assert.equal(isLastSegment(last), true);
  assert.equal(matches(last, meta.get(last)!, 'lmsg', 'all'), true);
  assert.equal(matches(broken, meta.get(broken)!, 'lmsg', 'all'), false);
  assert.equal(matches(broken, meta.get(broken)!, 'dash', 'all'), true);
  assert.equal(matches(last, meta.get(last)!, 'dash', 'all'), false);
});
