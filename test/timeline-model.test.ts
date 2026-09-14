import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lane, Span } from '../src/continuity';
import type { Segment } from '../src/capture';
import { groupDigits, issuesOf, rulerStep, stripCommonPrefix } from '../src/timeline-model';

const seg = (url: string): Segment => ({ url, time: new Date(), bytes: new Uint8Array(), boxes: [] });
const span = (start: number, duration: number | undefined, deltaBefore?: number): Span =>
  ({ segment: seg(`https://a/${start}.m4s`), start, duration, deltaBefore });
const lane = (timescale: number | undefined, spans: Span[], trackId = 1): Lane =>
  ({ key: `k${trackId}`, template: 'https://a/#.m4s', trackId, timescale, spans });

test('stripCommonPrefix cuts shared prefix at a slash boundary', () => {
  assert.deepEqual(
    stripCommonPrefix(['https://cdn/x/bbb/video_#.m4s', 'https://cdn/x/bbb/audio_#.m4a']),
    ['video_#.m4s', 'audio_#.m4a'],
  );
  assert.deepEqual(
    stripCommonPrefix(['https://cdn/x/v/seg_#.m4s', 'https://cdn/x/a/seg_#.m4a']),
    ['v/seg_#.m4s', 'a/seg_#.m4a'],
  );
});

test('stripCommonPrefix falls back to basename for a single lane', () => {
  assert.deepEqual(stripCommonPrefix(['https://cdn/x/video_#.m4s']), ['video_#.m4s']);
});

test('issuesOf lists gaps, overlaps and unknown durations sorted by time', () => {
  const lanes = [
    lane(1000, [span(0, 1000), span(1100, 1000, 100), span(2100, undefined, 0)], 1),
    lane(100, [span(0, 100), span(90, 100, -10)], 2),
  ];
  const issues = issuesOf(lanes);
  assert.deepEqual(
    issues.map((i) => [i.kind, i.t, i.lane.trackId]),
    [
      ['overlap', 0.9, 2],
      ['gap', 1.0, 1],
      ['unknown', 2.1, 1],
    ],
  );
});

test('issuesOf puts issues from lanes without timescale last', () => {
  const lanes = [lane(undefined, [span(0, 10), span(20, 10, 10)], 1), lane(10, [span(0, 10), span(15, 10, 5)], 2)];
  assert.deepEqual(issuesOf(lanes).map((i) => i.lane.trackId), [2, 1]);
});

test('rulerStep uses the most common span duration when it fits', () => {
  assert.equal(rulerStep([4, 4, 4.001, 2], 68, 1000), 4);
});

test('rulerStep falls back to a nice step of at least 60 px', () => {
  // 4 s at 1000 px over 6800 s = 0.6 px: too dense
  assert.equal(rulerStep([4, 4], 6800, 1000), 500);
  assert.equal(rulerStep([], 68, 1000), 5);
});

test('groupDigits groups thousands with narrow spaces', () => {
  assert.equal(groupDigits(1537920), '1 537 920');
  assert.equal(groupDigits(999), '999');
});
