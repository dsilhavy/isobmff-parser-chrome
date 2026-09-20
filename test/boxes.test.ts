import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import { childrenOf, findBox } from '../src/boxes';

const box = (type: string, fields: Record<string, unknown> = {}, boxes?: unknown[]): ParsedIsoBox =>
  ({ type, ...fields, ...(boxes ? { boxes } : {}) }) as unknown as ParsedIsoBox;

test('childrenOf: container boxes, stsd entries, none otherwise', () => {
  const avc1 = box('avc1', {}, [box('avcC')]);
  assert.deepEqual(childrenOf(box('stsd', { entries: [avc1] })), [avc1]);
  assert.deepEqual(childrenOf(box('moov', {}, [avc1])), [avc1]);
  assert.deepEqual(childrenOf(box('tfdt')), []);
});

test('findBox searches depth-first through stsd entries too', () => {
  const avcC = box('avcC');
  const tree = [box('moov', {}, [box('trak', {}, [box('mdia', {}, [box('minf', {}, [box('stbl', {}, [box('stsd', { entries: [box('avc1', {}, [avcC])] })])])])])])];
  assert.equal(findBox(tree, 'avcC'), avcC);
  assert.equal(findBox(tree, 'tfdt'), undefined);
});
