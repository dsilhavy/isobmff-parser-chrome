import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import { analyze, templateOf } from '../src/continuity';
import type { Segment } from '../src/capture';

// Minimal fake boxes: only the fields continuity.ts reads.
const box = (type: string, fields: Record<string, unknown> = {}, boxes?: unknown[]): ParsedIsoBox =>
  ({ type, ...fields, ...(boxes ? { boxes } : {}) }) as unknown as ParsedIsoBox;

function seg(url: string, boxes: ParsedIsoBox[]): Segment {
  return { url, time: new Date(), bytes: new Uint8Array(), boxes };
}

function init(url: string, trackId: number, timescale: number, handlerType = 'vide', trexDefaultDuration?: number): Segment {
  return seg(url, [
    box('moov', {}, [
      box('trak', {}, [
        box('tkhd', { trackId }),
        box('mdia', {}, [box('mdhd', { timescale }), box('hdlr', { handlerType })]),
      ]),
      box('mvex', {}, [box('trex', { trackId, defaultSampleDuration: trexDefaultDuration })]),
    ]),
  ]);
}

interface MediaOpts {
  trackId?: number;
  tfhdDefault?: number;
  durations?: (number | undefined)[]; // per-sample durations; undefined = omitted
}

function media(url: string, tfdt: number, opts: MediaOpts = {}): Segment {
  const { trackId = 1, tfhdDefault, durations = [1000, 1000] } = opts;
  return seg(url, [
    box('moof', {}, [
      box('traf', {}, [
        box('tfhd', { trackId, defaultSampleDuration: tfhdDefault }),
        box('tfdt', { baseMediaDecodeTime: tfdt }),
        box('trun', { sampleCount: durations.length, samples: durations.map((d) => ({ sampleDuration: d })) }),
      ]),
    ]),
  ]);
}

test('templateOf replaces last digit run in basename, drops query', () => {
  assert.equal(templateOf('https://a/v/video_1080p_0012.m4s?tok=1'), 'https://a/v/video_1080p_#.m4s');
  assert.equal(templateOf('https://a/v/12345678.m4s'), 'https://a/v/#.m4s');
  assert.equal(templateOf('https://a/v0/seg-3.m4s'), 'https://a/v0/seg-#.m4s');
  assert.equal(templateOf('https://a/v0/init.mp4'), 'https://a/v0/init.mp4');
});

test('continuous segments produce one lane with no deltas', () => {
  const lanes = analyze([
    init('https://a/v/init.mp4', 1, 90000),
    media('https://a/v/1.m4s', 0),
    media('https://a/v/2.m4s', 2000),
    media('https://a/v/3.m4s', 4000),
  ]);
  assert.equal(lanes.length, 1);
  const [lane] = lanes;
  assert.equal(lane.trackId, 1);
  assert.equal(lane.timescale, 90000);
  assert.equal(lane.handler, 'vide');
  assert.deepEqual(lane.spans.map((s) => [s.start, s.duration, s.deltaBefore]), [
    [0, 2000, undefined],
    [2000, 2000, 0],
    [4000, 2000, 0],
  ]);
});

test('gap and overlap are reported as deltaBefore in ticks', () => {
  const [lane] = analyze([
    media('https://a/v/1.m4s', 0),
    media('https://a/v/2.m4s', 2500), // +500 gap
    media('https://a/v/3.m4s', 4000), // -500 overlap
  ]);
  assert.deepEqual(lane.spans.map((s) => s.deltaBefore), [undefined, 500, -500]);
});

test('spans are ordered by tfdt, not by arrival', () => {
  const [lane] = analyze([
    media('https://a/v/2.m4s', 2000),
    media('https://a/v/1.m4s', 0),
  ]);
  assert.deepEqual(lane.spans.map((s) => s.start), [0, 2000]);
  assert.deepEqual(lane.spans.map((s) => s.deltaBefore), [undefined, 0]);
});

test('no init: timescale undefined, deltas still computed', () => {
  const [lane] = analyze([media('https://a/v/1.m4s', 0), media('https://a/v/2.m4s', 2100)]);
  assert.equal(lane.timescale, undefined);
  assert.equal(lane.spans[1].deltaBefore, 100);
});

test('duration falls back to tfhd default, then trex default from linked init', () => {
  const lanes = analyze([
    init('https://a/v/init.mp4', 1, 90000, 'vide', 3000),
    media('https://a/v/1.m4s', 0, { durations: [undefined, undefined], tfhdDefault: 500 }),
    media('https://a/v/2.m4s', 1000, { durations: [undefined] }),
    media('https://a/v/3.m4s', 4000),
  ]);
  assert.deepEqual(lanes[0].spans.map((s) => [s.duration, s.deltaBefore]), [
    [1000, undefined],
    [3000, 0],
    [2000, 0],
  ]);
});

test('unresolvable duration leaves duration undefined and skips the check', () => {
  const [lane] = analyze([
    media('https://a/v/1.m4s', 0, { durations: [undefined] }),
    media('https://a/v/2.m4s', 999),
  ]);
  assert.equal(lane.spans[0].duration, undefined);
  assert.equal(lane.spans[1].deltaBefore, undefined);
});

test('representations in the same directory get separate lanes and inits', () => {
  const lanes = analyze([
    init('https://a/v/video_720p_init.mp4', 1, 90000),
    init('https://a/v/video_1080p_init.mp4', 1, 12800),
    media('https://a/v/video_720p_1.m4s', 0),
    media('https://a/v/video_1080p_1.m4s', 0),
    media('https://a/v/video_720p_2.m4s', 2000),
  ]);
  assert.equal(lanes.length, 2);
  const byTemplate = Object.fromEntries(lanes.map((l) => [l.template, l]));
  assert.equal(byTemplate['https://a/v/video_720p_#.m4s'].timescale, 90000);
  assert.equal(byTemplate['https://a/v/video_720p_#.m4s'].spans.length, 2);
  assert.equal(byTemplate['https://a/v/video_1080p_#.m4s'].timescale, 12800);
});

test('muxed segment with two trafs lands in two lanes', () => {
  const muxed = seg('https://a/v/1.m4s', [
    box('moof', {}, [
      box('traf', {}, [box('tfhd', { trackId: 1 }), box('tfdt', { baseMediaDecodeTime: 0 }), box('trun', { samples: [{ sampleDuration: 10 }] })]),
      box('traf', {}, [box('tfhd', { trackId: 2 }), box('tfdt', { baseMediaDecodeTime: 5 }), box('trun', { samples: [{ sampleDuration: 20 }] })]),
    ]),
  ]);
  const lanes = analyze([muxed]);
  assert.deepEqual(lanes.map((l) => [l.trackId, l.spans[0].start, l.spans[0].duration]), [[1, 0, 10], [2, 5, 20]]);
});

test('multiple moofs in one segment (CMAF chunks) form one span', () => {
  const chunked = seg('https://a/v/1.m4s', [
    box('moof', {}, [box('traf', {}, [box('tfhd', { trackId: 1 }), box('tfdt', { baseMediaDecodeTime: 0 }), box('trun', { samples: [{ sampleDuration: 10 }] })])]),
    box('moof', {}, [box('traf', {}, [box('tfhd', { trackId: 1 }), box('tfdt', { baseMediaDecodeTime: 10 }), box('trun', { samples: [{ sampleDuration: 10 }] })])]),
  ]);
  const [lane] = analyze([chunked]);
  assert.equal(lane.spans.length, 1);
  assert.deepEqual([lane.spans[0].start, lane.spans[0].duration], [0, 20]);
});

test('init sharing only the origin with the media URL is not linked', () => {
  const [lane] = analyze([
    init('https://a/audio/init.mp4', 1, 48000, 'soun'),
    media('https://a/other/1.m4s', 0),
  ]);
  assert.equal(lane.timescale, undefined);
  assert.equal(lane.handler, undefined);
});
