import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxName } from '../src/box-names';

test('boxName returns ISO 14496-12 names for known types', () => {
  assert.equal(boxName('tfdt'), 'Track Fragment Decode Time');
  assert.equal(boxName('moof'), 'Movie Fragment');
  assert.equal(boxName('mdat'), 'Media Data');
});

test('boxName is undefined for unknown types', () => {
  assert.equal(boxName('zzzz'), undefined);
});
