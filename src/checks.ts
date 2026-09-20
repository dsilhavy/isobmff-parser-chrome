import { filterIsoBoxes, findIsoBox, isIsoBoxType, type IsoBoxMap } from '@svta/cml-iso-bmff';
import type { Segment } from './capture';
import { codecString } from './codecs';

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

/** Structural problems of one segment, human-readable; parse error first. */
export function warningsOf(segment: Segment): string[] {
  const out: string[] = [];
  if (segment.error) out.push(`parse error: ${segment.error}`);
  for (const stsd of all(segment.boxes, 'stsd')) {
    for (const entry of (stsd.entries ?? []) as { type: string }[]) {
      if (codecString(entry) === undefined) out.push(`no codec string for sample entry '${entry.type}'`);
    }
  }
  const top = segment.boxes as { type: string; size: number; largesize?: number }[];
  top.forEach((b, i) => {
    if (b.type !== 'moof') return;
    for (const traf of all([b], 'traf')) if (!find([traf], 'tfdt')) out.push('traf without tfdt');
    const next = top[i + 1];
    if (next?.type !== 'mdat') return;
    const payload = next.largesize !== undefined ? next.largesize - 16 : next.size - 8;
    const sum = sampleBytes(b);
    if (sum !== undefined && sum !== payload) out.push(`mdat ${payload.toLocaleString('en')} B, trun samples sum to ${sum.toLocaleString('en')} B`);
  });
  return out;
}
