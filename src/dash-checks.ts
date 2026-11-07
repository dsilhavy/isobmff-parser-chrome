import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import { childrenOf, findBox } from './boxes';
import type { Segment } from './capture';

/**
 * Segment format rules of ISO/IEC 23009-1 (DASH) 6.3 for ISO BMFF segments, checked on the boxes
 * of one captured segment. Every message starts with `DASH <clause>:` so it can be traced to the spec
 * and found with the `dash` filter keyword.
 *
 * Rules that always apply: Initialization Segment (6.3.4), Delivery Unit Media Segment (6.3.5.2, which
 * all Media Segments conform to), and the mdat placement of 6.3.2.1. Format-type rules (Simple,
 * Indexed, Sub-Indexed) are checked when the segment carries their brand in 'styp'.
 */

type Fields = Record<string, unknown>;
const f = (b: ParsedIsoBox) => b as unknown as Fields;
const all = (boxes: ParsedIsoBox[], type: string, out: ParsedIsoBox[] = []): ParsedIsoBox[] => {
  for (const b of boxes) {
    if (b.type === type) out.push(b);
    all(childrenOf(b), type, out);
  }
  return out;
};
const sizeOf = (b: ParsedIsoBox) => (f(b).largesize as number | undefined) ?? b.size;

const DEFAULT_BASE_IS_MOOF = 0x020000;
const BASE_DATA_OFFSET_PRESENT = 0x000001;
const DATA_OFFSET_PRESENT = 0x000001;

/** Compatible (and major) brands of the segment's 'styp' or 'ftyp'. */
export function brandsOf(boxes: ParsedIsoBox[]): Set<string> {
  const t = boxes.find((b) => b.type === 'styp' || b.type === 'ftyp');
  if (!t) return new Set();
  return new Set([f(t).majorBrand as string, ...((f(t).compatibleBrands as string[] | undefined) ?? [])].filter(Boolean));
}

/** 6.3.4 Initialization Segment: ftyp + moov with mvex, no moof, and empty sample tables. */
function initRules(top: ParsedIsoBox[]): string[] {
  const out: string[] = [];
  const types = top.map((b) => b.type);
  if (!types.includes('ftyp')) out.push("DASH 6.3.4: Initialization Segment without 'ftyp'");
  const moov = top.find((b) => b.type === 'moov')!;
  if (!childrenOf(moov).some((b) => b.type === 'mvex')) out.push("DASH 6.3.4: 'moov' without 'mvex' (no movie fragments announced)");
  for (const type of ['stts', 'stsc', 'stco', 'co64', 'stsz', 'stz2']) {
    for (const b of all([moov], type)) {
      const n = (f(b).entryCount ?? f(b).sampleCount) as number | undefined;
      if (n) out.push(`DASH 6.3.4: '${type}' in the Initialization Segment has ${n} ${type === 'stsz' || type === 'stz2' ? 'samples' : 'entries'} (shall be empty)`);
    }
  }
  return out;
}

/** 6.3.2.1 and 6.3.5.2 Delivery Unit Media Segment: self-contained fragments with moof-relative addressing. */
function deliveryUnitRules(top: ParsedIsoBox[]): string[] {
  const out = new Set<string>();
  top.forEach((b, i) => {
    if (b.type !== 'moof') return;
    const trafs = childrenOf(b).filter((c) => c.type === 'traf');
    if (!trafs.length) out.add("DASH 6.3.5.2: 'moof' without 'traf'");
    for (const traf of trafs) {
      const tfhd = childrenOf(traf).find((c) => c.type === 'tfhd');
      const flags = (tfhd && (f(tfhd).flags as number)) ?? 0;
      if (flags & BASE_DATA_OFFSET_PRESENT) out.add("DASH 6.3.5.2: 'tfhd' uses base-data-offset (absolute addressing)");
      else if (tfhd && !(flags & DEFAULT_BASE_IS_MOOF)) out.add("DASH 6.3.5.2: 'tfhd' without default-base-is-moof");
      for (const trun of childrenOf(traf).filter((c) => c.type === 'trun')) {
        if (!((f(trun).flags as number) & DATA_OFFSET_PRESENT)) out.add("DASH 6.3.5.2: 'trun' without data-offset");
      }
    }
    const next = top.slice(i + 1).findIndex((c) => c.type === 'moof');
    const until = next < 0 ? top.length : i + 1 + next;
    if (!top.slice(i + 1, until).some((c) => c.type === 'mdat')) out.add("DASH 6.3.2.1: 'moof' not followed by an 'mdat' before the next 'moof'");
  });
  return [...out];
}

/** 6.3.5.3 Simple format: box order of styp / prft / emsg relative to mdat, and the first sidx. */
function simpleRules(top: ParsedIsoBox[], length: number): string[] {
  const out: string[] = [];
  const idx = (type: string) => top.map((b, i) => (b.type === type ? i : -1)).filter((i) => i >= 0);
  const styp = idx('styp');
  const prft = idx('prft');
  const emsg = idx('emsg');
  const mdat = idx('mdat');
  const moof = idx('moof');
  const sidx = idx('sidx');
  const lastMdat = mdat.at(-1) ?? -1;
  if (styp.length && styp[0] !== 0) out.push("DASH 6.3.5.3: 'styp' is not the first box");
  if (prft.length > 1) out.push(`DASH 6.3.5.3: ${prft.length} 'prft' boxes (at most one)`);
  if (prft.length && styp.length && prft[0] < styp[0]) out.push("DASH 6.3.5.3: 'prft' before 'styp'");
  if (prft.length && prft[0] > lastMdat) out.push("DASH 6.3.5.3: 'prft' after the last 'mdat'");
  if (emsg.length && emsg[0] > lastMdat) out.push("DASH 6.3.5.3: 'emsg' after the last 'mdat'");
  if (sidx.length && moof.length && sidx[0] > moof[0]) out.push("DASH 6.3.5.3: first 'sidx' after the first 'moof'");
  if (sidx.length && moof.length) {
    // the first sidx documents the entire segment: its references end where the segment ends
    let pos = 0;
    for (let i = 0; i < sidx[0]; i++) pos += sizeOf(top[i]);
    const s = f(top[sidx[0]]);
    const refs = (s.references as { referencedSize: number }[] | undefined) ?? [];
    const end = pos + sizeOf(top[sidx[0]]) + ((s.firstOffset as number) ?? 0) + refs.reduce((n, r) => n + r.referencedSize, 0);
    // ponytail: only "too short" is reported; a longer span is what a byte-range capture of an on-demand file looks like
    if (end < length) out.push(`DASH 6.3.5.3: first 'sidx' documents ${end.toLocaleString('en')} of ${length.toLocaleString('en')} bytes`);
  }
  return out;
}

/** 6.3.5.4 Indexed ('msix') and 6.3.5.5 Sub-Indexed ('sims') Media Segments. */
function indexedRules(top: ParsedIsoBox[], brands: Set<string>): string[] {
  const out: string[] = [];
  const types = top.map((b) => b.type);
  if (brands.has('msix') || brands.has('sims')) {
    const firstMoof = types.indexOf('moof');
    const firstSidx = types.indexOf('sidx');
    if (firstSidx < 0 || (firstMoof >= 0 && firstSidx > firstMoof)) out.push("DASH 6.3.5.4: 'msix' segment without a 'sidx' before the first 'moof'");
    types.forEach((t, i) => {
      if (t === 'moof' && types[i + 1] !== 'mdat') out.push("DASH 6.3.5.4: 'msix' segment with a 'moof' not immediately followed by its 'mdat'");
    });
  }
  if (brands.has('sims')) {
    const ssix = types.indexOf('ssix');
    if (ssix < 0) out.push("DASH 6.3.5.5: 'sims' segment without 'ssix'");
    else if (types[ssix - 1] !== 'sidx') out.push("DASH 6.3.5.5: 'ssix' does not immediately follow a 'sidx'");
  }
  return [...new Set(out)];
}

/** DASH segment-format problems of one captured segment. */
export function dashWarnings(segment: Segment): string[] {
  if (segment.error) return [];
  const top = segment.boxes;
  const hasMoov = top.some((b) => b.type === 'moov');
  const hasMoof = top.some((b) => b.type === 'moof');
  if (hasMoov && !hasMoof) return initRules(top);
  if (!hasMoof) return []; // index segment, sidx-only byte range, …
  const brands = brandsOf(top);
  return [...deliveryUnitRules(top), ...simpleRules(top, segment.bytes.byteLength), ...indexedRules(top, brands)];
}

/** Last Media Segment of the Representation ('lmsg' brand, 23009-1 7.3.1). */
export const isLastSegment = (segment: Segment): boolean => brandsOf(segment.boxes).has('lmsg') && !!findBox(segment.boxes, 'moof');
