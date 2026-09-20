import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lane, Span } from '../src/continuity';
import type { Segment } from '../src/capture';
import { avOffset, eventsOf, groupDigits, issuesOf, ntpToDate, rulerStep, stripCommonPrefix } from '../src/timeline-model';

const seg = (url: string): Segment => ({ url, time: new Date(), bytes: new Uint8Array(), boxes: [] });
const span = (start: number, duration: number | undefined, deltaBefore?: number): Span =>
  ({ segment: seg(`https://a/${start}.m4s`), start, duration, deltaBefore, sampleCount: 1 });
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

test('issuesOf carries the delta in ticks and reports gaps between chunks inside a span', () => {
  const s = span(0, 30);
  s.chunks = [{ start: 0, duration: 10 }, { start: 12, duration: 10 }, { start: 20, duration: 10 }]; // +2 gap, -2 overlap
  const issues = issuesOf([lane(10, [s, span(30, 10, 5)])]);
  assert.deepEqual(issues.map((i) => [i.kind, i.t, i.delta]), [
    ['gap', 1.0, 2],
    ['overlap', 2.0, -2],
    ['gap', 2.5, 5],
  ]);
});

test('issuesOf flags a video span that does not start on a sync sample', () => {
  const bad = span(0, 10);
  bad.syncOffsets = [5];
  const audio = span(0, 10);
  audio.syncOffsets = [5];
  const unknown = span(10, 10, 0);
  const v = lane(10, [bad, unknown]);
  v.handler = 'vide';
  const a = lane(10, [audio], 2);
  a.handler = 'soun';
  assert.deepEqual(issuesOf([v, a]).map((i) => [i.kind, i.t]), [['nosync', 0]]);
});

test('avOffset is first video start minus first audio start in seconds', () => {
  const v = lane(90000, [span(9000, 1)]);
  v.handler = 'vide';
  const a = lane(48000, [span(2400, 1)], 2);
  a.handler = 'soun';
  assert.equal(avOffset([v, a]), 0.05);
  assert.equal(avOffset([v]), undefined);
});

test('eventsOf places emsg v1 by presentationTime and v0 relative to the segment span', () => {
  const s = seg('https://a/1.m4s');
  const emsgV1 = { type: 'emsg', version: 1, timescale: 1000, presentationTime: 2500, eventDuration: 0, id: 7, schemeIdUri: 'urn:scte:scte35:2013:bin', value: '' };
  const emsgV0 = { type: 'emsg', version: 0, timescale: 1000, presentationTimeDelta: 500, eventDuration: 0, id: 8, schemeIdUri: 'urn:mpeg:dash:event:2012', value: '1' };
  s.boxes = [emsgV1, emsgV0] as unknown as typeof s.boxes;
  const sp = span(9000, 9000);
  sp.segment = s;
  const events = eventsOf([s], [lane(9000, [sp])]);
  assert.deepEqual(events.map((e) => [e.t, e.label, e.box.id]), [[2.5, 'bin', 7], [1.5, '2012', 8]]);
});

test('ntpToDate converts NTP seconds + fraction to a Date', () => {
  assert.equal(ntpToDate(2208988800, 0).getTime(), 0);
  assert.equal(ntpToDate(2208988800 + 1, 0x80000000).getTime(), 1500);
});
