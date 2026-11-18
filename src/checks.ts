import { dashIssues } from './dash-checks';
import { issueText, type Issue } from './findings';
import { filterIsoBoxes, findIsoBox, isIsoBoxType, type IsoBoxMap } from '@svta/cml-iso-bmff';
import type { Segment } from './capture';
import { codecString } from './codecs';
import { trafGroupWarnings } from './sample-groups';
import type { ParsedIsoBox } from '@svta/cml-iso-bmff';

const find = <T extends keyof IsoBoxMap>(boxes: Iterable<unknown>, type: T): IsoBoxMap[T] | null =>
  findIsoBox(boxes, (b): b is IsoBoxMap[T] => isIsoBoxType(type, b));
const all = <T extends keyof IsoBoxMap>(boxes: Iterable<unknown>, type: T): IsoBoxMap[T][] =>
  filterIsoBoxes(boxes, (b): b is IsoBoxMap[T] => isIsoBoxType(type, b));

/** Sum of sample sizes over all trafs of `moof`; undefined if any sample has no resolvable size. */
function sampleBytes(moof: unknown): number | undefined {
  let total = 0;
  for (const traf of all([moof], 'traf')) {
    const tfhd = find([traf], 'tfhd');
    for (const trun of all([traf], 'trun')) {
      for (const s of trun.samples) {
        const size = s.sampleSize ?? tfhd?.defaultSampleSize;
        if (size === undefined) return undefined;
        total += size;
      }
    }
  }
  return total;
}

const cache = new WeakMap<Segment, Issue[]>();

/** Structural problems of one segment; parse error first. Cached: a captured segment does not change. */
export function issuesOf(segment: Segment): Issue[] {
  let issues = cache.get(segment);
  if (!issues) cache.set(segment, (issues = check(segment)));
  return issues;
}

/** The same as human-readable one-liners. */
export const warningsOf = (segment: Segment): string[] => issuesOf(segment).map(issueText);

function check(segment: Segment): Issue[] {
  const out: Issue[] = [];
  if (segment.error) out.push({ id: 'segment.parse', severity: 'error', message: 'Segment could not be parsed', detail: segment.error, summary: `parse error: ${segment.error}` });
  for (const stsd of all(segment.boxes, 'stsd')) {
    for (const entry of (stsd.entries ?? []) as { type: string }[]) {
      if (codecString(entry) === undefined) out.push({ id: 'segment.codec-string', severity: 'info', message: 'No codec string can be derived for a sample entry', detail: `sample entry '${entry.type}'`, summary: `no codec string for sample entry '${entry.type}'`, box: 'stsd' });
    }
  }
  const top = segment.boxes as { type: string; size: number; largesize?: number }[];
  top.forEach((b, i) => {
    if (b.type !== 'moof') return;
    for (const traf of all([b], 'traf')) {
      if (!find([traf], 'tfdt')) out.push({ id: 'segment.tfdt', severity: 'warning', message: "Track fragment without 'tfdt'", detail: 'the decode time of the fragment is unknown, so gaps and overlaps cannot be checked', summary: 'traf without tfdt', box: 'traf' });
      out.push(
        ...trafGroupWarnings(traf as unknown as ParsedIsoBox).map((text): Issue => {
          const count = text.includes(' maps ');
          return {
            id: count ? 'segment.sbgp-count' : 'segment.sbgp-index',
            severity: 'warning',
            message: count ? "'sbgp' maps a different number of samples than the truns hold" : "'sbgp' refers to a missing fragment-local group description",
            detail: text,
            summary: text,
            box: 'sbgp',
          };
        }),
      );
    }
    const next = top[i + 1];
    if (next?.type !== 'mdat') return;
    const payload = next.largesize !== undefined ? next.largesize - 16 : next.size - 8;
    const sum = sampleBytes(b);
    if (sum !== undefined && sum !== payload) {
      out.push({ id: 'segment.mdat-size', severity: 'warning', message: "mdat size differs from the sum of the 'trun' sample sizes", detail: `mdat ${payload.toLocaleString('en')} B, trun samples sum to ${sum.toLocaleString('en')} B (${Math.abs(payload - sum).toLocaleString('en')} B ${payload > sum ? 'unreferenced' : 'missing'})`, summary: `mdat ${payload.toLocaleString('en')} B, trun samples sum to ${sum.toLocaleString('en')} B`, box: 'trun' });
    }
  });
  out.push(...dashIssues(segment));
  return out;
}
