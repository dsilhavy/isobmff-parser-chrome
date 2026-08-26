import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIsoBmff } from '../src/sniff.ts';

const box = (type: string, size: number, pad = 0): Uint8Array => {
  const bytes = new Uint8Array(Math.max(8 + pad, size));
  new DataView(bytes.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
  return bytes;
};

test('accepts init segment (ftyp)', () => assert.ok(isIsoBmff(box('ftyp', 24))));
test('accepts media segment (styp, moof)', () => {
  assert.ok(isIsoBmff(box('styp', 24)));
  assert.ok(isIsoBmff(box('moof', 16)));
});
test('accepts size 0 (to end of file)', () => assert.ok(isIsoBmff(box('mdat', 0, 8))));
test('accepts 64-bit largesize', () => assert.ok(isIsoBmff(box('mdat', 1, 16))));
test('rejects size larger than buffer', () => assert.equal(isIsoBmff(box('moof', 9999)?.subarray(0, 32)), false));
test('rejects HTML', () => assert.equal(isIsoBmff(new TextEncoder().encode('<!doctype html><html>')), false));
test('rejects JSON', () => assert.equal(isIsoBmff(new TextEncoder().encode('{"key": "value here"}')), false));
test('rejects short buffer', () => assert.equal(isIsoBmff(new Uint8Array(4)), false));
