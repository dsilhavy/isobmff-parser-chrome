import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import { diff, flatten } from '../src/diff';

const box = (type: string, fields: Record<string, unknown> = {}, boxes?: unknown[]): ParsedIsoBox =>
  ({ type, size: 8, view: {}, ...fields, ...(boxes ? { boxes } : {}) }) as unknown as ParsedIsoBox;

const moov = (timescale: number, extraTrak = false, kid = [1, 2]) =>
  box('moov', {}, [
    box('mvhd', { timescale: 1000, duration: 0 }),
    box('trak', {}, [box('tkhd', { trackId: 1 }), box('mdia', {}, [box('mdhd', { timescale }), box('minf', {}, [box('stbl', {}, [box('stsd', { entries: [box('encv', {}, [box('sinf', {}, [box('schi', {}, [box('tenc', { defaultKid: kid })])])])] })])])])]),
    ...(extraTrak ? [box('trak', {}, [box('tkhd', { trackId: 2 })])] : []),
  ]);

test('flatten: paths with sibling indices, skips size/view/boxes, formats byte arrays', () => {
  const m = flatten([moov(90000)]);
  assert.equal(m.get('moov/mvhd.timescale'), '1000');
  assert.equal(m.get('moov/trak/mdia/mdhd.timescale'), '90000');
  assert.equal(m.get('moov/trak/mdia/minf/stbl/stsd/encv/sinf/schi/tenc.defaultKid'), '1, 2');
  assert.equal(m.has('moov.size'), false);
  assert.equal(m.has('moov/trak/mdia/minf/stbl/stsd.entries'), false);
  const two = flatten([moov(90000, true)]);
  assert.equal(two.get('moov/trak[1]/tkhd.trackId'), '2');
  assert.equal(two.get('moov/trak/tkhd.trackId'), '1');
});

test('diff: changed, removed and added leaves in path order', () => {
  assert.deepEqual(diff([moov(90000)], [moov(12800, true, [1, 3])]), [
    { path: 'moov/trak/mdia/mdhd.timescale', a: '90000', b: '12800' },
    { path: 'moov/trak/mdia/minf/stbl/stsd/encv/sinf/schi/tenc.defaultKid', a: '1, 2', b: '1, 3' },
    { path: 'moov/trak[1]/tkhd.trackId', b: '2' },
  ]);
  assert.deepEqual(diff([moov(1)], [moov(1)]), []);
});
