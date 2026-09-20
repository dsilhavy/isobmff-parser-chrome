import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import type { Segment } from '../src/capture';
import { warningsOf } from '../src/checks';

const box = (type: string, fields: Record<string, unknown> = {}, boxes?: unknown[]): ParsedIsoBox =>
  ({ type, size: 8, ...fields, ...(boxes ? { boxes } : {}) }) as unknown as ParsedIsoBox;
const seg = (boxes: ParsedIsoBox[], error?: string): Segment => ({ url: 'https://a/1.m4s', time: new Date(), bytes: new Uint8Array(), boxes, error });

const moof = (sizes: (number | undefined)[], tfhdDefault?: number, withTfdt = true) =>
  box('moof', {}, [
    box('traf', {}, [
      box('tfhd', { trackId: 1, defaultSampleSize: tfhdDefault }),
      ...(withTfdt ? [box('tfdt', { baseMediaDecodeTime: 0 })] : []),
      box('trun', { samples: sizes.map((sampleSize) => ({ sampleSize })) }),
    ]),
  ]);
const mdat = (size: number) => box('mdat', { size: size + 8 });

test('no warnings for a consistent segment', () => {
  assert.deepEqual(warningsOf(seg([box('styp'), moof([100, 200]), mdat(300)])), []);
});

test('mdat payload size differing from the sample size sum is reported', () => {
  assert.deepEqual(warningsOf(seg([moof([100, 200], undefined), mdat(250)])), ['mdat 250 B, trun samples sum to 300 B']);
});

test('tfhd default sample size fills in; unresolvable sizes skip the check', () => {
  assert.deepEqual(warningsOf(seg([moof([undefined, undefined], 50), mdat(100)])), []);
  assert.deepEqual(warningsOf(seg([moof([undefined, undefined]), mdat(999)])), []);
});

test('largesize mdat uses the 16-byte header', () => {
  assert.deepEqual(warningsOf(seg([moof([10]), box('mdat', { size: 1, largesize: 26 })])), []);
});

test('missing tfdt and parse errors are listed, error first', () => {
  assert.deepEqual(warningsOf(seg([moof([10], undefined, false), mdat(10)], 'boom')), ['parse error: boom', 'traf without tfdt']);
});

test('init: sample entries without a derivable codec string are reported', () => {
  const stsd = (entry: ParsedIsoBox) => box('moov', {}, [box('trak', {}, [box('mdia', {}, [box('minf', {}, [box('stbl', {}, [box('stsd', { entries: [entry] })])])])])]);
  assert.deepEqual(warningsOf(seg([stsd(box('dvh1', {}, [box('dvcC')]))])), ["no codec string for sample entry 'dvh1'"]);
  assert.deepEqual(warningsOf(seg([stsd(box('avc1', {}, [box('avcC', { avcProfileIndication: 66, profileCompatibility: 0, avcLevelIndication: 30 })]))])), []);
});
