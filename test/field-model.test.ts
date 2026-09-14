import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import { derived, fieldOffsets } from '../src/field-model';

const box = (type: string, fields: Record<string, unknown>, size = 100): ParsedIsoBox =>
  ({ type, size, ...fields }) as unknown as ParsedIsoBox;

test('fieldOffsets: header, version/flags and body fields of a tfdt v1', () => {
  assert.deepEqual(fieldOffsets(box('tfdt', { version: 1, flags: 0, baseMediaDecodeTime: 5 }, 20)), [
    { key: 'size', start: 0, end: 4, type: 'u32' },
    { key: 'type', start: 4, end: 8, type: 'str' },
    { key: 'version', start: 8, end: 9, type: 'u8' },
    { key: 'flags', start: 9, end: 12, type: 'u24' },
    { key: 'baseMediaDecodeTime', start: 12, end: 20, type: 'u64' },
  ]);
});

test('fieldOffsets: tfhd skips fields its flags do not carry', () => {
  const ranges = fieldOffsets(box('tfhd', { version: 0, flags: 0x020008, trackId: 1, defaultSampleDuration: 2 }, 20));
  assert.deepEqual(ranges.slice(4).map((r) => [r.key, r.start, r.end]), [
    ['trackId', 12, 16],
    ['defaultSampleDuration', 16, 20],
  ]);
});

test('fieldOffsets: largesize header shifts the body; tail field runs to the end', () => {
  const ranges = fieldOffsets(box('trun', { version: 0, flags: 0x000301, sampleCount: 2, dataOffset: 8, samples: [] }, 60));
  assert.deepEqual(ranges.filter((r) => ['sampleCount', 'dataOffset', 'samples'].includes(r.key)).map((r) => [r.key, r.start, r.end, r.type]), [
    ['sampleCount', 12, 16, 'u32'],
    ['dataOffset', 16, 20, 'i32'],
    ['samples', 20, 60, 'bytes'],
  ]);
  const big = fieldOffsets(box('mfhd', { version: 0, flags: 0, sequenceNumber: 1, largesize: 24 }, 1));
  assert.deepEqual(big.slice(0, 4).map((r) => [r.key, r.start, r.end]), [
    ['size', 0, 4], ['type', 4, 8], ['largesize', 8, 16], ['version', 16, 17],
  ]);
});

test('fieldOffsets: unknown box type yields header only (plus version/flags when present)', () => {
  assert.deepEqual(fieldOffsets(box('zzzz', {}, 16)).map((r) => r.key), ['size', 'type']);
  assert.deepEqual(fieldOffsets(box('zzzz', { version: 0, flags: 1 }, 16)).map((r) => r.key), ['size', 'type', 'version', 'flags']);
});

test('derived: time fields in seconds, flags as hex', () => {
  assert.equal(derived('baseMediaDecodeTime', 384000, 48000), '= 8.000 s @ 48000 Hz');
  assert.equal(derived('baseMediaDecodeTime', 384000, undefined), undefined);
  assert.equal(derived('flags', 0x20000, 48000), '0x020000');
  assert.equal(derived('trackId', 1, 48000), undefined);
});
