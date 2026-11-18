import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import type { Segment } from '../src/capture';
import type { Lane } from '../src/continuity';
import { issuesOf, warningsOf } from '../src/checks';
import { dashIssues } from '../src/dash-checks';
import { collectFindings, groupFindings, issueText, matchesGroup, severityCounts, type Issue } from '../src/findings';
import { addMpd, type MpdEntry } from '../src/mpd/store';

const box = (type: string, fields: Record<string, unknown> = {}, boxes?: unknown[]): ParsedIsoBox =>
  ({ type, ...fields, ...(boxes ? { boxes } : {}) }) as unknown as ParsedIsoBox;
const seg = (url: string, boxes: ParsedIsoBox[], time = 1000): Segment => ({ url, time: new Date(time), bytes: new Uint8Array(16), boxes });
// media segment whose tfhd lacks default-base-is-moof and whose traf has no tfdt
const media = (url: string, time?: number) =>
  seg(url, [box('moof', {}, [box('traf', {}, [box('tfhd', { trackId: 1, flags: 0 }), box('trun', { flags: 1, samples: [] })])]), box('mdat', { size: 8 })], time);

test('DASH rules carry a stable id, the clause and error severity', () => {
  const issues = dashIssues(media('https://a/v/1.m4s'));
  assert.deepEqual(issues, [{
    id: 'dash.tfhd-default-base-is-moof',
    severity: 'error',
    clause: 'ISO/IEC 23009-1 6.3.5.2',
    message: "'tfhd' without default-base-is-moof",
    requirement: "Track fragments address their data relative to the 'moof': 'tfhd' sets default-base-is-moof.",
  }]);
  assert.equal(issueText(issues[0]), "DASH 6.3.5.2: 'tfhd' without default-base-is-moof");
});

test('a rule broken by several boxes of one segment is reported once', () => {
  const traf = () => box('traf', {}, [box('tfhd', { flags: 0 }), box('tfdt'), box('trun', { flags: 1, samples: [] })]);
  const s = seg('https://a/v/1.m4s', [box('moof', {}, [traf(), traf()]), box('mdat', { size: 8 })]);
  assert.deepEqual(dashIssues(s).map((i) => i.id), ['dash.tfhd-default-base-is-moof']);
});

test('issuesOf covers structural checks and is cached per segment; warningsOf is its text form', () => {
  const s = media('https://a/v/1.m4s');
  const issues = issuesOf(s);
  assert.deepEqual(issues.map((i) => [i.id, i.severity, i.box]), [['segment.tfdt', 'warning', 'traf'], ['dash.tfhd-default-base-is-moof', 'error', undefined]]);
  assert.equal(issuesOf(s), issues);
  assert.deepEqual(warningsOf(s), ['traf without tfdt', "DASH 6.3.5.2: 'tfhd' without default-base-is-moof"]);
  const broken: Segment = { ...seg('https://a/x', []), error: 'boom' };
  assert.deepEqual(issuesOf(broken), [{ id: 'segment.parse', severity: 'error', message: 'Segment could not be parsed', detail: 'boom', summary: 'parse error: boom' }]);
  assert.deepEqual(warningsOf(broken), ['parse error: boom']);
});

test('collectFindings ties MPD, segment and timeline problems to their place', () => {
  const s1 = media('https://a/v/seg_1.m4s?x=1', 1000);
  const s2 = media('https://a/v/seg_2.m4s', 2000);
  const lanes: Lane[] = [{ key: 'v#1', template: 't', trackId: 1, timescale: 1000, spans: [
    { segment: s1, start: 0, duration: 100, sampleCount: 1 },
    { segment: s2, start: 140, duration: 100, deltaBefore: 40, sampleCount: 1 },
  ] }];
  const mpds: MpdEntry[] = [];
  const { snapshot } = addMpd(mpds, { url: 'https://a/live/manifest.mpd', time: 500, text: '<MPD>\n<Period>\n</MPD>' });
  const custom = (s: Segment): Issue[] => (s === s1 ? [{ id: 'x.rule', severity: 'info', message: 'note', box: 'moof' }] : []);
  const findings = collectFindings([s1, s2], lanes, mpds, custom);
  assert.deepEqual(findings.map((f) => [f.id, f.source, f.where, f.detail]), [
    ['mpd.well-formed', 'mpd', `manifest.mpd · version ${snapshot.id}`, 'line 3: </MPD> closes <Period> opened on line 2'],
    ['x.rule', 'segment', 'seg_1.m4s', undefined],
    ['timeline.gap', 'segment', 'seg_2.m4s', 'track 1 · 0.04 s before this segment'],
  ]);
  assert.deepEqual(findings[0].location, { kind: 'mpd', url: 'https://a/live/manifest.mpd', snapshotId: snapshot.id, line: 3 });
  assert.deepEqual(findings[1].location, { kind: 'segment', segment: s1, box: 'moof' });
  assert.equal(findings.every((f) => f.lens === 'conformance'), true);
  // a span whose segment left the capture is not reported
  assert.deepEqual(collectFindings([s1], lanes, [], () => []), []);
});

test('a sidx that leaves out the moof is explained with its numbers, and all such segments form one group', () => {
  // styp(24) sidx(44) moof(100) mdat(sizes differ per segment); the sidx references count only the mdat
  const short = (url: string, mdat: number) => {
    const s = seg(url, [
      box('styp', { size: 24, majorBrand: 'msdh', compatibleBrands: ['msdh'] }),
      box('sidx', { size: 44, firstOffset: 0, references: [{ referencedSize: mdat }] }),
      box('moof', { size: 100 }, [box('traf', {}, [box('tfhd', { flags: 0x020000 }), box('tfdt'), box('trun', { flags: 1, samples: [] })])]),
      box('mdat', { size: mdat }),
    ]);
    return { ...s, bytes: new Uint8Array(168 + mdat) };
  };
  const a = short('https://a/v/1.m4s', 1000);
  const b = short('https://a/v/2.m4s', 2000);
  const [issue] = dashIssues(a).filter((i) => i.id === 'dash.sidx-coverage');
  assert.equal(issue.message, "First 'sidx' does not document the entire segment");
  assert.equal(issue.detail, "'sidx' at offset 24 (44 B), first_offset 0, 1 reference totalling 1,000 B: documented up to byte 1,068, segment is 1,168 B, 100 B not covered. The missing 100 bytes equal the size of the 'moof': the references seem to count only the 'mdat'.");
  assert.equal(issueText(issue), "DASH 6.3.5.3: first 'sidx' documents 1,068 of 1,168 bytes");
  const groups = groupFindings(collectFindings([a, b], [], [], dashIssues)).filter((g) => g.id === 'dash.sidx-coverage');
  assert.deepEqual(groups.map((g) => [g.findings.length, !!g.requirement]), [[2, true]]);
});

test('groupFindings merges equal problems, errors first; filter and counts work on groups', () => {
  const segments = [media('https://a/v/1.m4s'), media('https://a/v/2.m4s'), media('https://a/v/3.m4s')];
  const groups = groupFindings(collectFindings(segments, [], [], issuesOf));
  assert.deepEqual(groups.map((g) => [g.id, g.severity, g.findings.length]), [['dash.tfhd-default-base-is-moof', 'error', 3], ['segment.tfdt', 'warning', 3]]);
  assert.deepEqual(severityCounts(groups), { error: 1, warning: 1, info: 0 });
  const match = (q: string) => groups.filter((g) => matchesGroup(g, q)).map((g) => g.id);
  assert.deepEqual(match('error'), ['dash.tfhd-default-base-is-moof']);
  assert.deepEqual(match('6.3.5.2 segment'), ['dash.tfhd-default-base-is-moof']);
  assert.deepEqual(match('TFDT'), ['segment.tfdt']);
  assert.deepEqual(match('mpd'), []);
  assert.equal(match('').length, 2);
});
