import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import type { Lane } from '../src/continuity';
import type { Segment } from '../src/capture';
import { groupSegments, matches, metaOf } from '../src/list-model';

const box = (type: string, fields: Record<string, unknown> = {}, boxes?: unknown[]): ParsedIsoBox =>
  ({ type, ...fields, ...(boxes ? { boxes } : {}) }) as unknown as ParsedIsoBox;
const seg = (url: string, boxes: ParsedIsoBox[] = [box('moof')], size = 10): Segment =>
  ({ url, time: new Date(), bytes: new Uint8Array(size), boxes });

const initSeg = seg('https://a/v/init.mp4', [box('moov', {}, [box('trak', {}, [box('mdia', {}, [box('hdlr', { handlerType: 'vide' })])])])]);
const m1 = seg('https://a/v/seg_1.m4s');
const m2 = seg('https://a/v/seg_2.m4s', undefined, 20);
const a1 = seg('https://a/a/seg_1.m4a');
const lanes: Lane[] = [
  { key: 'v#1', template: 'https://a/v/seg_#.m4s', trackId: 1, handler: 'vide', timescale: 90000, spans: [
    { segment: m1, start: 0, duration: 100 },
    { segment: m2, start: 110, duration: 100, deltaBefore: 10 },
  ] },
  { key: 'a#2', template: 'https://a/a/seg_#.m4a', trackId: 2, handler: 'soun', timescale: 48000, spans: [{ segment: a1, start: 0, duration: 100 }] },
];
const meta = metaOf([initSeg, m1, m2, a1], lanes);

test('metaOf derives kind, tracks, handlers and issue per segment', () => {
  assert.equal(meta.get(initSeg)!.kind, 'init');
  assert.deepEqual([...meta.get(initSeg)!.handlers], ['vide']);
  assert.equal(meta.get(m2)!.kind, 'media');
  assert.deepEqual([...meta.get(m2)!.tracks], [1]);
  assert.equal(meta.get(m2)!.issue, 'gap');
  assert.equal(meta.get(m1)!.issue, undefined);
});

test('matches: substring, keywords and kind filter', () => {
  assert.equal(matches(m1, meta.get(m1)!, 'SEG_1', 'all'), true);
  assert.equal(matches(m1, meta.get(m1)!, 'seg_2', 'all'), false);
  assert.equal(matches(m1, meta.get(m1)!, 'track:1', 'all'), true);
  assert.equal(matches(a1, meta.get(a1)!, 'track:1', 'all'), false);
  assert.equal(matches(a1, meta.get(a1)!, 'soun', 'all'), true);
  assert.equal(matches(m1, meta.get(m1)!, 'soun', 'all'), false);
  assert.equal(matches(initSeg, meta.get(initSeg)!, 'init', 'all'), true);
  assert.equal(matches(m2, meta.get(m2)!, 'gap', 'all'), true);
  assert.equal(matches(m1, meta.get(m1)!, 'gap', 'all'), false);
  assert.equal(matches(m1, meta.get(m1)!, 'vide seg_1', 'all'), true);
  assert.equal(matches(m1, meta.get(m1)!, '', 'init'), false);
  assert.equal(matches(m2, meta.get(m2)!, '', 'issues'), true);
  assert.equal(matches(m1, meta.get(m1)!, '', 'issues'), false);
});

test('groupSegments groups by template in first-seen order with count and size', () => {
  const groups = groupSegments([initSeg, m1, a1, m2], meta);
  assert.deepEqual(groups.map((g) => [g.template, g.segments.length, g.size, g.handler]), [
    ['https://a/v/init.mp4', 1, 10, 'vide'],
    ['https://a/v/seg_#.m4s', 2, 30, 'vide'],
    ['https://a/a/seg_#.m4a', 1, 10, 'soun'],
  ]);
});
