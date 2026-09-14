import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip, entriesFor } from '../src/save';
import type { Segment } from '../src/capture';

function segment(url: string, body: string): Segment {
  return { url, time: new Date(), bytes: new TextEncoder().encode(body), boxes: [] };
}

const SEGMENTS = [
  segment('https://cdn.example.com/v/init.mp4', 'init payload'),
  segment('https://cdn.example.com/v/seg-1.m4s?tok=abc', 'media payload one'),
  segment('https://other.example.net/a/seg 2#frag.m4s', 'media payload two'),
  segment('https://cdn.example.com/v/init.mp4', 'init payload again'),
];

const EXPECTED = [
  'cdn.example.com/0001-init.mp4',
  'cdn.example.com/0002-seg-1.m4s',
  'other.example.net/0003-seg_2',
  'cdn.example.com/0004-init.mp4',
];

test('buildZip produces an archive unzip accepts, with expected paths and contents', async () => {
  const entries = entriesFor(SEGMENTS);
  assert.deepEqual(entries.map((e) => e.path), EXPECTED);

  const path = join(mkdtempSync(join(tmpdir(), 'isobmff-zip-')), 'segments.zip');
  writeFileSync(path, Buffer.from(await buildZip(entries).arrayBuffer()));

  execFileSync('unzip', ['-t', path]); // throws on a bad CRC, header or offset

  const listed = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(listed, EXPECTED);

  for (const [i, entry] of entries.entries()) {
    const extracted = execFileSync('unzip', ['-p', path, entry.path], { encoding: 'utf8' });
    assert.equal(extracted, new TextDecoder().decode(SEGMENTS[i].bytes));
  }
});

test('buildZip handles an empty selection', async () => {
  const zip = buildZip([]);
  assert.equal(zip.size, 22); // end-of-central-directory record only
});
