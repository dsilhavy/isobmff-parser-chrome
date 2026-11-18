import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import { childrenOf, findBox } from './boxes';
import type { Segment } from './capture';
import { DASH, issueText, type Issue } from './findings';

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
/** All rules here are requirements ("shall") of the segment formats, hence errors. */
const d = (id: string, clause: string, message: string, detail?: string, summary?: string): Issue => ({
  id: `dash.${id}`,
  severity: 'error',
  clause: `${DASH} ${clause}`,
  message,
  ...(detail ? { detail } : {}),
  ...(summary ? { summary } : {}),
  ...(REQUIRES[id] ? { requirement: REQUIRES[id] } : {}),
});

/** What the clause asks for, in our words (not a quotation of the standard). */
const REQUIRES: Record<string, string> = {
  'init-ftyp': "An Initialization Segment starts with a file type box ('ftyp').",
  'init-mvex': "The 'moov' of an Initialization Segment contains 'mvex', announcing that the media is in movie fragments.",
  'init-sample-tables': "The sample tables in the 'moov' ('stts', 'stsc', 'stco'/'co64', 'stsz'/'stz2') carry no entries: all samples are in movie fragments.",
  'moof-traf': "Each movie fragment ('moof') contains at least one track fragment ('traf').",
  'tfhd-base-data-offset': "Track fragments address their data relative to the 'moof': 'tfhd' does not set base-data-offset-present.",
  'tfhd-default-base-is-moof': "Track fragments address their data relative to the 'moof': 'tfhd' sets default-base-is-moof.",
  'trun-data-offset': "Each 'trun' carries a data offset (data-offset-present).",
  'moof-mdat': "Each 'moof' is followed by the 'mdat' with its media data before the next 'moof'.",
  'styp-first': "When present, the segment type box ('styp') is the first box of the Media Segment.",
  'prft-count': "A Media Segment in the simple format carries at most one 'prft' box.",
  'prft-before-styp': "A 'prft' box comes after 'styp'.",
  'prft-after-mdat': "'prft' comes before the last 'mdat' of the segment.",
  'emsg-after-mdat': "'emsg' boxes come before the last 'mdat' of the segment.",
  'sidx-before-moof': "The first 'sidx' comes before the first 'moof'.",
  'sidx-coverage': "The first 'sidx' documents the entire segment: sidx position + size + first_offset + the sum of its referenced sizes equals the segment size.",
  'msix-sidx': "An Indexed Media Segment (brand 'msix') has a 'sidx' before the first 'moof'.",
  'msix-moof-mdat': "In an Indexed Media Segment (brand 'msix') each 'moof' is immediately followed by its 'mdat'.",
  'sims-ssix': "A Sub-Indexed Media Segment (brand 'sims') contains an 'ssix'.",
  'ssix-after-sidx': "An 'ssix' immediately follows the 'sidx' it refines.",
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
function initRules(top: ParsedIsoBox[]): Issue[] {
  const out: Issue[] = [];
  const types = top.map((b) => b.type);
  if (!types.includes('ftyp')) out.push(d('init-ftyp', '6.3.4', "Initialization Segment without 'ftyp'"));
  const moov = top.find((b) => b.type === 'moov')!;
  if (!childrenOf(moov).some((b) => b.type === 'mvex')) out.push(d('init-mvex', '6.3.4', "'moov' without 'mvex' (no movie fragments announced)"));
  for (const type of ['stts', 'stsc', 'stco', 'co64', 'stsz', 'stz2']) {
    for (const b of all([moov], type)) {
      const n = (f(b).entryCount ?? f(b).sampleCount) as number | undefined;
      if (n) out.push(d('init-sample-tables', '6.3.4', 'Sample table in the Initialization Segment is not empty', `'${type}' has ${n} ${type === 'stsz' || type === 'stz2' ? 'samples' : 'entries'}`, `'${type}' in the Initialization Segment has ${n} ${type === 'stsz' || type === 'stz2' ? 'samples' : 'entries'} (shall be empty)`));
    }
  }
  return out;
}

/** 6.3.2.1 and 6.3.5.2 Delivery Unit Media Segment: self-contained fragments with moof-relative addressing. */
function deliveryUnitRules(top: ParsedIsoBox[]): Issue[] {
  const out: Issue[] = [];
  top.forEach((b, i) => {
    if (b.type !== 'moof') return;
    const trafs = childrenOf(b).filter((c) => c.type === 'traf');
    if (!trafs.length) out.push(d('moof-traf', '6.3.5.2', "'moof' without 'traf'"));
    for (const traf of trafs) {
      const tfhd = childrenOf(traf).find((c) => c.type === 'tfhd');
      const flags = (tfhd && (f(tfhd).flags as number)) ?? 0;
      if (flags & BASE_DATA_OFFSET_PRESENT) out.push(d('tfhd-base-data-offset', '6.3.5.2', "'tfhd' uses base-data-offset (absolute addressing)"));
      else if (tfhd && !(flags & DEFAULT_BASE_IS_MOOF)) out.push(d('tfhd-default-base-is-moof', '6.3.5.2', "'tfhd' without default-base-is-moof"));
      for (const trun of childrenOf(traf).filter((c) => c.type === 'trun')) {
        if (!((f(trun).flags as number) & DATA_OFFSET_PRESENT)) out.push(d('trun-data-offset', '6.3.5.2', "'trun' without data-offset"));
      }
    }
    const next = top.slice(i + 1).findIndex((c) => c.type === 'moof');
    const until = next < 0 ? top.length : i + 1 + next;
    if (!top.slice(i + 1, until).some((c) => c.type === 'mdat')) out.push(d('moof-mdat', '6.3.2.1', "'moof' not followed by an 'mdat' before the next 'moof'"));
  });
  return out;
}

/** 6.3.5.3 Simple format: box order of styp / prft / emsg relative to mdat, and the first sidx. */
function simpleRules(top: ParsedIsoBox[], length: number): Issue[] {
  const out: Issue[] = [];
  const idx = (type: string) => top.map((b, i) => (b.type === type ? i : -1)).filter((i) => i >= 0);
  const styp = idx('styp');
  const prft = idx('prft');
  const emsg = idx('emsg');
  const mdat = idx('mdat');
  const moof = idx('moof');
  const sidx = idx('sidx');
  const lastMdat = mdat.at(-1) ?? -1;
  if (styp.length && styp[0] !== 0) out.push(d('styp-first', '6.3.5.3', "'styp' is not the first box"));
  if (prft.length > 1) out.push(d('prft-count', '6.3.5.3', "More than one 'prft' box", `${prft.length} 'prft' boxes`, `${prft.length} 'prft' boxes (at most one)`));
  if (prft.length && styp.length && prft[0] < styp[0]) out.push(d('prft-before-styp', '6.3.5.3', "'prft' before 'styp'"));
  if (prft.length && prft[0] > lastMdat) out.push(d('prft-after-mdat', '6.3.5.3', "'prft' after the last 'mdat'"));
  if (emsg.length && emsg[0] > lastMdat) out.push(d('emsg-after-mdat', '6.3.5.3', "'emsg' after the last 'mdat'"));
  if (sidx.length && moof.length && sidx[0] > moof[0]) out.push(d('sidx-before-moof', '6.3.5.3', "first 'sidx' after the first 'moof'"));
  if (sidx.length && moof.length) {
    // the first sidx documents the entire segment: its references end where the segment ends
    let pos = 0;
    for (let i = 0; i < sidx[0]; i++) pos += sizeOf(top[i]);
    const s = f(top[sidx[0]]);
    const refs = (s.references as { referencedSize: number }[] | undefined) ?? [];
    const end = pos + sizeOf(top[sidx[0]]) + ((s.firstOffset as number) ?? 0) + refs.reduce((n, r) => n + r.referencedSize, 0);
    // ponytail: only "too short" is reported; a longer span is what a byte-range capture of an on-demand file looks like
    if (end < length) {
      const n = (v: number) => v.toLocaleString('en');
      const missing = length - end;
      const firstMoof = top[moof[0]];
      const hint = sizeOf(firstMoof) === missing ? ` The missing ${n(missing)} bytes equal the size of the 'moof': the references seem to count only the 'mdat'.` : '';
      out.push(d(
        'sidx-coverage',
        '6.3.5.3',
        "First 'sidx' does not document the entire segment",
        `'sidx' at offset ${n(pos)} (${n(sizeOf(top[sidx[0]]))} B), first_offset ${n((s.firstOffset as number) ?? 0)}, ${refs.length} reference${refs.length === 1 ? '' : 's'} totalling ${n(refs.reduce((sum, r) => sum + r.referencedSize, 0))} B: documented up to byte ${n(end)}, segment is ${n(length)} B, ${n(missing)} B not covered.${hint}`,
        `first 'sidx' documents ${n(end)} of ${n(length)} bytes`,
      ));
    }
  }
  return out;
}

/** 6.3.5.4 Indexed ('msix') and 6.3.5.5 Sub-Indexed ('sims') Media Segments. */
function indexedRules(top: ParsedIsoBox[], brands: Set<string>): Issue[] {
  const out: Issue[] = [];
  const types = top.map((b) => b.type);
  if (brands.has('msix') || brands.has('sims')) {
    const firstMoof = types.indexOf('moof');
    const firstSidx = types.indexOf('sidx');
    if (firstSidx < 0 || (firstMoof >= 0 && firstSidx > firstMoof)) out.push(d('msix-sidx', '6.3.5.4', "'msix' segment without a 'sidx' before the first 'moof'"));
    types.forEach((t, i) => {
      if (t === 'moof' && types[i + 1] !== 'mdat') out.push(d('msix-moof-mdat', '6.3.5.4', "'msix' segment with a 'moof' not immediately followed by its 'mdat'"));
    });
  }
  if (brands.has('sims')) {
    const ssix = types.indexOf('ssix');
    if (ssix < 0) out.push(d('sims-ssix', '6.3.5.5', "'sims' segment without 'ssix'"));
    else if (types[ssix - 1] !== 'sidx') out.push(d('ssix-after-sidx', '6.3.5.5', "'ssix' does not immediately follow a 'sidx'"));
  }
  return out;
}

/** DASH segment-format problems of one captured segment; a rule broken the same way by several boxes is reported once. */
export function dashIssues(segment: Segment): Issue[] {
  const seen = new Set<string>();
  const key = (i: Issue) => `${i.id}\n${i.detail ?? ''}`;
  return rulesFor(segment).filter((i) => !seen.has(key(i)) && !!seen.add(key(i)));
}

/** The same as one-line texts (`DASH <clause>: <message>`). */
export const dashWarnings = (segment: Segment): string[] => dashIssues(segment).map(issueText);

function rulesFor(segment: Segment): Issue[] {
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
