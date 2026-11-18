import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, isSegmentCandidate, type CaptureEvent } from '../src/bridge.ts';
import { pollDelay } from '../src/eme/capture.ts';

const seg = (url: string): CaptureEvent => ({ type: 'segment', segment: { url, time: 0, bytes: new Uint8Array(8) } });
const nav = (url: string): CaptureEvent => ({ type: 'navigated', url });
const sinkOf = (events: CaptureEvent[], visible: boolean[] = []) => ({ event: (e: CaptureEvent) => void events.push(e), visible: (v: boolean) => void visible.push(v) });
const label = (e: CaptureEvent) => (e.type === 'segment' ? e.segment.url : e.type === 'navigated' ? `nav:${e.url}` : e.type === 'mpd' ? `mpd:${e.mpd.url}` : e.exchange.url);

test('segment candidates: fetch/xhr/media and unknown types pass, page resources and textual bodies do not', () => {
  assert.equal(isSegmentCandidate({ resourceType: 'fetch', mimeType: 'video/mp4' }), true);
  assert.equal(isSegmentCandidate({ resourceType: 'xhr', mimeType: 'application/octet-stream' }), true);
  assert.equal(isSegmentCandidate({ resourceType: 'media', mimeType: 'video/mp4' }), true);
  assert.equal(isSegmentCandidate({}), true);
  assert.equal(isSegmentCandidate({ resourceType: 'other', mimeType: 'video/iso.segment' }), true);
  for (const resourceType of ['image', 'font', 'stylesheet', 'script', 'document']) assert.equal(isSegmentCandidate({ resourceType }), false);
  for (const mimeType of ['text/plain', 'image/png', 'application/json; charset=utf-8', 'application/dash+xml', 'application/javascript', 'application/vnd.apple.mpegurl+json']) {
    assert.equal(isSegmentCandidate({ resourceType: 'fetch', mimeType }), false, mimeType);
  }
  assert.equal(isSegmentCandidate({ resourceType: 'fetch', mimeType: 'application/xml-dtd' }), true);
});

test('queue buffers in order until a sink connects, then forwards directly', () => {
  const q = createQueue();
  q.push(seg('a'));
  q.push(nav('p2'));
  q.push(seg('b'));
  const events: CaptureEvent[] = [];
  q.connect(sinkOf(events));
  assert.deepEqual(events.map(label), ['a', 'nav:p2', 'b']);
  q.push(seg('c'));
  assert.deepEqual(events.map(label), ['a', 'nav:p2', 'b', 'c']);
});

test('queue caps buffered segments (oldest dropped) and collapses consecutive navigations', () => {
  const q = createQueue({ segment: 2, exchange: 1, mpd: 1 });
  q.push(nav('p1'));
  q.push(nav('p2'));
  q.push({ type: 'mpd', mpd: { url: 'm1', time: 0, text: '<MPD/>' } });
  for (const u of ['a', 'b', 'c']) q.push(seg(u));
  q.push({ type: 'mpd', mpd: { url: 'm2', time: 0, text: '<MPD/>' } });
  const events: CaptureEvent[] = [];
  q.connect(sinkOf(events));
  assert.deepEqual(events.map(label), ['nav:p2', 'b', 'c', 'mpd:m2']);
});

test('queue reports visibility on connect and on change, and survives a throwing sink', () => {
  const q = createQueue();
  q.setVisible(true);
  const visible: boolean[] = [];
  q.connect(sinkOf([], visible));
  q.setVisible(false);
  assert.deepEqual(visible, [true, false]);

  const bad = createQueue();
  bad.connect({ event: () => { throw new Error('gone'); }, visible: () => { throw new Error('gone'); } });
  bad.push(seg('a'));
  bad.setVisible(true);
});

test('EME poll pacing', () => {
  assert.equal(pollDelay(true, true, false), 500);
  assert.equal(pollDelay(true, false, true), 500);
  assert.equal(pollDelay(true, false, false), 2000);
  assert.equal(pollDelay(false, true, false), 5000);
  assert.equal(pollDelay(false, false, true), null);
});
