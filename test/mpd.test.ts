import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attr, childrenOf, decodeEntities, parseXml } from '../src/mpd/xml.ts';
import { isMpdCandidate, isMpdText } from '../src/mpd/sniff.ts';
import { parseDuration, summarize } from '../src/mpd/model.ts';
import { addMpd, type MpdEntry } from '../src/mpd/store.ts';
import { highlightLines } from '../src/mpd/highlight.ts';

const MPD = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment with <tags> -->
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" type="dynamic"
     profiles="urn:mpeg:dash:profile:isoff-live:2011, urn:mpeg:dash:profile:cmaf:2019"
     minBufferTime="PT2S" minimumUpdatePeriod="PT0.5S" availabilityStartTime="1970-01-01T00:00:00Z">
  <Period id="p0" start="PT0S">
    <AdaptationSet mimeType="video/mp4" codecs="avc1.64001f" width="1280" height="720" frameRate="25">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="0123"/>
      <Representation id="v1" bandwidth="1000000"/>
      <Representation id="v2" bandwidth="3000000" width="1920" height="1080" codecs="avc1.640028">
        <BaseURL>v2/?a=1&amp;b=2</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" lang="en">
      <Representation id="a1" bandwidth="128000" mimeType="audio/mp4" codecs="mp4a.40.2" audioSamplingRate="48000"/>
    </AdaptationSet>
  </Period>
</MPD>
`;

test('parseXml builds the element tree with lines, namespaces and decoded text', () => {
  const doc = parseXml(MPD);
  assert.deepEqual(doc.errors, []);
  const mpd = doc.root!;
  assert.equal(mpd.local, 'MPD');
  assert.equal(mpd.ns, 'urn:mpeg:dash:schema:mpd:2011');
  assert.equal(mpd.line, 3);
  assert.equal(mpd.endLine, 18);
  assert.equal(attr(mpd, 'minBufferTime'), 'PT2S');
  assert.equal(mpd.attrs.find((a) => a.name === 'profiles')!.line, 4);
  const [period] = childrenOf(mpd, 'Period');
  assert.equal(period.line, 6);
  assert.equal(period.parent, mpd);
  const [video] = childrenOf(period, 'AdaptationSet');
  const cp = childrenOf(video, 'ContentProtection')[0];
  assert.equal(cp.ns, 'urn:mpeg:dash:schema:mpd:2011');
  assert.equal(attr(cp, 'cenc:default_KID'), '0123');
  assert.deepEqual([cp.line, cp.endLine], [8, 8]);
  const v2 = childrenOf(video, 'Representation')[1];
  assert.deepEqual([v2.line, v2.endLine], [10, 12]);
  assert.equal(childrenOf(v2, 'BaseURL')[0].text, 'v2/?a=1&b=2');
  assert.equal(MPD.slice(v2.start, v2.end).startsWith('<Representation id="v2"'), true);
  assert.equal(MPD.slice(v2.start, v2.end).endsWith('</Representation>'), true);
  assert.equal(doc.lineCount, 19);
});

test('parseXml resolves prefixed elements, CDATA, DOCTYPE and a BOM', () => {
  const doc = parseXml('﻿<!DOCTYPE MPD [ <!ENTITY x "y"> ]>\n<d:MPD xmlns:d="urn:d"><d:a><![CDATA[1 < 2]]></d:a></d:MPD>');
  assert.deepEqual(doc.errors, []);
  assert.deepEqual([doc.root!.prefix, doc.root!.local, doc.root!.ns], ['d', 'MPD', 'urn:d']);
  assert.equal(doc.root!.children[0].text, '1 < 2');
});

test('parseXml reports well-formedness errors with the line', () => {
  const err = (xml: string) => parseXml(xml).errors.map((e) => `${e.line}: ${e.message}`);
  assert.deepEqual(err('<MPD>\n<Period>\n</MPD>'), ['3: </MPD> closes <Period> opened on line 2']);
  assert.deepEqual(err('<MPD>\n<Period>'), ['2: <Period> is never closed']);
  assert.deepEqual(err('<MPD a="1" a="2"/>'), ['1: duplicate attribute a on <MPD>']);
  assert.deepEqual(err('<MPD>\n<Period id=p0/></MPD>'), ['2: malformed start tag <Period>']);
  assert.deepEqual(err('<MPD/>\n<MPD/>'), ['2: <MPD> after the root element']);
  assert.deepEqual(err('<MPD/> text'), ['1: text outside the root element']);
  assert.deepEqual(err('  '), ['1: no root element']);
  assert.deepEqual(err('<MPD><!-- oops</MPD>'), ['1: unterminated comment']);
  // the tree parsed so far is kept
  assert.equal(parseXml('<MPD>\n<Period>').root!.children[0].endLine, 2);
});

test('decodeEntities', () => {
  assert.equal(decodeEntities('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos; &#65;&#x42; &unknown;'), '<a> & "b" \'c\' AB &unknown;');
});

test('isMpdText accepts an MPD root after prolog, comments and DOCTYPE only', () => {
  assert.equal(isMpdText(MPD), true);
  assert.equal(isMpdText('﻿  <MPD/>'), true);
  assert.equal(isMpdText('<!DOCTYPE MPD><mpd:MPD xmlns:mpd="urn:x">'), true);
  assert.equal(isMpdText('<MPDx/>'), false);
  assert.equal(isMpdText('<Period><MPD/></Period>'), false);
  assert.equal(isMpdText('<!-- <MPD> '), false);
  assert.equal(isMpdText('#EXTM3U'), false);
  assert.equal(isMpdText(''), false);
});

test('isMpdCandidate: XML or textual content types, or .mpd in the URL', () => {
  assert.equal(isMpdCandidate({ resourceType: 'fetch', mimeType: 'application/dash+xml' }), true);
  assert.equal(isMpdCandidate({ resourceType: 'xhr', mimeType: 'text/plain; charset=utf-8' }), true);
  assert.equal(isMpdCandidate({ resourceType: 'fetch', mimeType: '' }), true);
  assert.equal(isMpdCandidate({ resourceType: 'fetch', mimeType: 'application/octet-stream', url: 'https://a/b/manifest.mpd?t=1' }), true);
  assert.equal(isMpdCandidate({ resourceType: 'fetch', mimeType: 'application/octet-stream', url: 'https://a/b/seg.m4s' }), false);
  assert.equal(isMpdCandidate({ resourceType: 'fetch', mimeType: 'video/mp4', url: 'https://a/mpd/seg.mp4' }), false);
  assert.equal(isMpdCandidate({ resourceType: 'script', mimeType: 'text/javascript' }), false);
  assert.equal(isMpdCandidate({ resourceType: 'image', mimeType: 'image/svg+xml' }), false);
});

test('parseDuration', () => {
  assert.equal(parseDuration('PT2S'), 2);
  assert.equal(parseDuration('PT0.5S'), 0.5);
  assert.equal(parseDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseDuration('P1DT1S'), 86401);
  assert.equal(parseDuration('-PT5S'), -5);
  for (const bad of [undefined, '', 'P', 'PT', 'P1DT', '2S', 'PT2']) assert.equal(parseDuration(bad), undefined, String(bad));
});

test('summarize reads MPD attributes and inherits common attributes into Representations', () => {
  const s = summarize(parseXml(MPD))!;
  assert.equal(s.type, 'dynamic');
  assert.deepEqual(s.profiles, ['urn:mpeg:dash:profile:isoff-live:2011', 'urn:mpeg:dash:profile:cmaf:2019']);
  assert.equal(s.minBufferTime, 2);
  assert.equal(s.minimumUpdatePeriod, 0.5);
  assert.equal(s.mediaPresentationDuration, undefined);
  assert.equal(s.periods.length, 1);
  assert.deepEqual([s.periods[0].id, s.periods[0].start], ['p0', 0]);
  const [video, audio] = s.periods[0].adaptationSets;
  assert.equal(video.contentType, 'video');
  const strip = ({ element: _e, ...rest }: (typeof video.representations)[number]) => rest;
  assert.deepEqual(video.representations.map(strip), [
    { id: 'v1', bandwidth: 1000000, codecs: 'avc1.64001f', mimeType: 'video/mp4', width: 1280, height: 720, frameRate: '25', audioSamplingRate: undefined },
    { id: 'v2', bandwidth: 3000000, codecs: 'avc1.640028', mimeType: 'video/mp4', width: 1920, height: 1080, frameRate: '25', audioSamplingRate: undefined },
  ]);
  assert.deepEqual([audio.contentType, audio.lang, audio.representations[0].audioSamplingRate], ['audio', 'en', '48000']);
  assert.equal(summarize(parseXml('<Period/>')), undefined);
  assert.equal(summarize(parseXml('<MPD/>'))!.type, 'static');
});

test('addMpd groups by URL, folds identical consecutive refreshes and caps the history', () => {
  const entries: MpdEntry[] = [];
  const a1 = addMpd(entries, { url: 'a', time: 1, text: '<MPD publishTime="1"/>' }, 2);
  const a2 = addMpd(entries, { url: 'a', time: 2, text: '<MPD publishTime="1"/>' }, 2);
  assert.deepEqual([a1.added, a2.added, a2.snapshot === a1.snapshot], [true, false, true]);
  assert.deepEqual([a1.snapshot.count, a1.snapshot.time, a1.snapshot.lastTime], [2, 1, 2]);
  addMpd(entries, { url: 'b', time: 3, text: '<MPD/>' }, 2);
  addMpd(entries, { url: 'a', time: 4, text: '<MPD publishTime="2"/>' }, 2);
  addMpd(entries, { url: 'a', time: 5, text: '<MPD publishTime="1"/>' }, 2); // same as the first, but not consecutive
  assert.deepEqual(entries.map((e) => [e.url, e.snapshots.length, e.refreshes]), [['a', 2, 4], ['b', 1, 1]]);
  assert.deepEqual(entries[0].snapshots.map((s) => s.time), [4, 5]);
  assert.equal(entries[0].snapshots[0].summary!.publishTime, '2');
  const bad = addMpd(entries, { url: 'c', time: 6, text: '<MPD>' });
  assert.equal(bad.snapshot.doc.errors.length, 1);
});

test('highlightLines colours tags, attributes, values, comments and declarations per line', () => {
  const lines = highlightLines('<?xml version="1.0"?>\r\n<!-- a\nb -->\n<MPD type="static"\n  cenc:kid=\'1\'>\n  <BaseURL>a/b</BaseURL><S/>\n</MPD>\n');
  assert.deepEqual(lines, [
    [['meta', '<?xml version="1.0"?>']],
    [['comment', '<!-- a']],
    [['comment', 'b -->']],
    [['punct', '<'], ['tag', 'MPD'], ['text', ' '], ['attr', 'type'], ['punct', '='], ['value', '"static"']],
    [['text', '  '], ['attr', 'cenc:kid'], ['punct', '='], ['value', "'1'"], ['punct', '>']],
    [['text', '  '], ['punct', '<'], ['tag', 'BaseURL'], ['punct', '>'], ['text', 'a/b'], ['punct', '</'], ['tag', 'BaseURL'], ['punct', '><'], ['tag', 'S'], ['punct', '/>']],
    [['punct', '</'], ['tag', 'MPD'], ['punct', '>']],
    [],
  ]);
});

test('highlightLines keeps every character of malformed input', () => {
  for (const text of ['<MPD a="1', '<MPD <Period>', '<!-- open', 'x < y', '<MPD a=1 b>\n</MPD', '<![CDATA[ ]]', '']) {
    assert.equal(highlightLines(text).map((l) => l.map((t) => t[1]).join('')).join('\n'), text, text);
  }
});
