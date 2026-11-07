import type { IsoBoxReadView, ParsedIsoBox } from '@svta/cml-iso-bmff';
import { childrenOf } from './boxes';
import { hexUuid, toHex } from './eme/bytes';

/**
 * Sample groups (ISO/IEC 14496-12 8.9): SampleGroupDescriptionBox 'sgpd' with decoded entries for the
 * grouping types that matter for streaming, SampleToGroupBox 'sbgp', and per-sample resolution.
 */

export type GroupEntry = Record<string, string | number | undefined>;

export interface SgpdBox {
  type: 'sgpd';
  version: number;
  flags: number;
  groupingType: string;
  defaultLength?: number;
  defaultGroupDescriptionIndex?: number;
  entryCount: number;
  entries: GroupEntry[];
}

export interface SbgpBox {
  type: 'sbgp';
  version: number;
  flags: number;
  groupingType: string;
  groupingTypeParameter?: number;
  entryCount: number;
  entries: { sampleCount: number; groupDescriptionIndex: number }[];
}

/** Fixed entry sizes, for version 0 boxes that carry no lengths. */
const FIXED_SIZE: Record<string, number> = { roll: 2, prol: 2, 'rap ': 1, tele: 1, 'sap ': 1, drap: 4, sync: 1 };

/** One SampleGroupDescriptionEntry of `groupingType`; unknown types keep their bytes as hex. */
export function decodeGroupEntry(groupingType: string, d: Uint8Array): GroupEntry {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  try {
    switch (groupingType) {
      case 'roll': // 10.1 VisualRollRecoveryEntry / AudioRollRecoveryEntry
      case 'prol': // 10.1 AudioPreRollEntry
        return { rollDistance: dv.getInt16(0) };
      case 'rap ': // 10.4 VisualRandomAccessEntry
        return { numLeadingSamplesKnown: d[0] >> 7, numLeadingSamples: d[0] & 127 };
      case 'tele': // 10.5 TemporalLevelEntry
        return { levelIndependentlyDecodable: d[0] >> 7 };
      case 'sap ': // 10.6 SAPEntry
        return { dependentFlag: d[0] >> 7, sapType: d[0] & 15 };
      case 'drap': // 10.8 VisualDRAPEntry
        return { drapType: d[0] >> 5 };
      case 'sync': // ISO/IEC 14496-15 SyncSampleEntry
        return { nalUnitType: d[0] & 63 };
      case 'seig': {
        // ISO/IEC 23001-7 6: CencSampleEncryptionInformationGroupEntry
        const isProtected = d[2];
        const perSampleIvSize = d[3];
        const entry: GroupEntry = { isProtected, perSampleIvSize, kid: hexUuid(d.subarray(4, 20)), cryptByteBlock: d[1] >> 4, skipByteBlock: d[1] & 15 };
        if (isProtected === 1 && perSampleIvSize === 0 && d.length > 20) entry.constantIv = toHex(d.subarray(21, 21 + d[20]));
        return entry;
      }
    }
  } catch {
    /* entry shorter than its syntax: fall through to raw */
  }
  return { length: d.length, data: toHex(d) };
}

export function readSgpd(view: IsoBoxReadView): Omit<SgpdBox, 'type'> {
  const { version, flags } = view.readFullBox();
  const groupingType = view.readString(4);
  const defaultLength = version >= 1 ? view.readUint(4) : undefined;
  const defaultGroupDescriptionIndex = version >= 2 ? view.readUint(4) : undefined;
  const entryCount = view.readUint(4);
  const entries: GroupEntry[] = [];
  for (let i = 0; i < entryCount && view.bytesRemaining > 0; i++) {
    let length = version >= 1 ? defaultLength || view.readUint(4) : FIXED_SIZE[groupingType];
    // ponytail: v0 of a type without a fixed size (e.g. seig with a constant IV) takes the rest as one entry
    if (length === undefined) length = view.bytesRemaining;
    entries.push(decodeGroupEntry(groupingType, view.readData(Math.min(length, view.bytesRemaining))));
  }
  return { version, flags, groupingType, defaultLength, defaultGroupDescriptionIndex, entryCount, entries };
}

export function readSbgp(view: IsoBoxReadView): Omit<SbgpBox, 'type'> {
  const { version, flags } = view.readFullBox();
  const groupingType = view.readString(4);
  const groupingTypeParameter = version === 1 ? view.readUint(4) : undefined;
  const entryCount = view.readUint(4);
  const entries: SbgpBox['entries'] = [];
  for (let i = 0; i < entryCount && view.bytesRemaining >= 8; i++) entries.push({ sampleCount: view.readUint(4), groupDescriptionIndex: view.readUint(4) });
  return { version, flags, groupingType, groupingTypeParameter, entryCount, entries };
}

// ---------- resolution ----------

const LOCAL = 0x10000;
const byType = <T extends { type: string }>(boxes: ParsedIsoBox[], type: string) => boxes.filter((b) => b.type === type) as unknown as T[];

/** Sample group descriptions in the sample table of `trak` (the init segment's track). */
export function stblGroups(trak: ParsedIsoBox | undefined): SgpdBox[] {
  let box = trak;
  for (const type of ['mdia', 'minf', 'stbl']) box = box && childrenOf(box).find((b) => b.type === type);
  return box ? byType<SgpdBox>(childrenOf(box), 'sgpd') : [];
}

/** Sample group descriptions of track `trackId` in an init segment's moov. */
export function initGroups(initBoxes: ParsedIsoBox[] | undefined, trackId: number | undefined): SgpdBox[] {
  const moov = initBoxes?.find((b) => b.type === 'moov');
  const trak = moov && childrenOf(moov).find((t) => t.type === 'trak' && (childrenOf(t).find((b) => b.type === 'tkhd') as { trackId?: number } | undefined)?.trackId === trackId);
  return stblGroups(trak);
}

export interface SampleGroup {
  groupingType: string;
  index: number; // as written in sbgp (or the default); > 0x10000 = fragment-local
  entry?: GroupEntry; // undefined when the referenced description is not available
}

/**
 * Group membership of every sample of `traf` (in trun order), by grouping type.
 * Indexes ≤ 0x10000 refer to `moovGroups` (the track's stbl), > 0x10000 to the traf's own sgpd (8.9.4).
 * Samples not covered by sbgp take the default_group_description_index (traf sgpd first, then stbl).
 */
export function trafSampleGroups(traf: ParsedIsoBox, moovGroups: SgpdBox[] = []): SampleGroup[][] {
  const kids = childrenOf(traf);
  const local = byType<SgpdBox>(kids, 'sgpd');
  const total = kids.filter((b) => b.type === 'trun').reduce((n, t) => n + ((t as unknown as { samples: unknown[] }).samples?.length ?? 0), 0);
  const out: SampleGroup[][] = Array.from({ length: total }, () => []);
  const resolve = (type: string, index: number): GroupEntry | undefined => {
    if (index > LOCAL) return local.find((g) => g.groupingType === type)?.entries[index - LOCAL - 1];
    return moovGroups.find((g) => g.groupingType === type)?.entries[index - 1];
  };
  const types = new Set([...local, ...moovGroups].map((g) => g.groupingType));
  for (const sbgp of byType<SbgpBox>(kids, 'sbgp')) types.add(sbgp.groupingType);
  for (const type of types) {
    const sbgp = byType<SbgpBox>(kids, 'sbgp').find((s) => s.groupingType === type);
    const def =
      local.find((g) => g.groupingType === type)?.defaultGroupDescriptionIndex || moovGroups.find((g) => g.groupingType === type)?.defaultGroupDescriptionIndex || 0;
    const indexes: number[] = [];
    for (const e of sbgp?.entries ?? []) for (let i = 0; i < e.sampleCount && indexes.length < total; i++) indexes.push(e.groupDescriptionIndex);
    for (let s = 0; s < total; s++) {
      const index = s < indexes.length ? indexes[s] : def;
      if (index === 0 || index === LOCAL) continue;
      out[s].push({ groupingType: type, index, entry: resolve(type, index) });
    }
  }
  return out;
}

/** Short label of one membership, e.g. `seig 1a2b3c4d…`, `roll -1`, `sap 1`. */
export function groupLabel(g: SampleGroup): string {
  const t = g.groupingType.trim();
  const e = g.entry;
  if (!e) return `${t} #${g.index > LOCAL ? `${g.index - LOCAL} (traf)` : g.index}`;
  switch (g.groupingType) {
    case 'seig':
      return e.isProtected ? `seig ${String(e.kid).slice(0, 8)}…` : 'seig clear';
    case 'roll':
    case 'prol':
      return `${t} ${e.rollDistance}`;
    case 'sap ':
      return `sap ${e.sapType}`;
    case 'rap ':
      return e.numLeadingSamplesKnown ? `rap ${e.numLeadingSamples} leading` : 'rap';
    case 'sync':
      return `sync nal ${e.nalUnitType}`;
    case 'drap':
      return `drap ${e.drapType}`;
    default:
      return `${t} #${g.index > LOCAL ? g.index - LOCAL : g.index}`;
  }
}

/** Problems in the sample groups of one traf: sbgp sample totals and dangling fragment-local indexes. */
export function trafGroupWarnings(traf: ParsedIsoBox): string[] {
  const kids = childrenOf(traf);
  const local = byType<SgpdBox>(kids, 'sgpd');
  const total = kids.filter((b) => b.type === 'trun').reduce((n, t) => n + ((t as unknown as { samples: unknown[] }).samples?.length ?? 0), 0);
  const out: string[] = [];
  for (const sbgp of byType<SbgpBox>(kids, 'sbgp')) {
    const t = sbgp.groupingType;
    const sum = sbgp.entries.reduce((n, e) => n + e.sampleCount, 0);
    if (sum !== total) out.push(`sbgp '${t}' maps ${sum} samples, the truns have ${total}`);
    const sgpd = local.find((g) => g.groupingType === t);
    const bad = sbgp.entries.find((e) => e.groupDescriptionIndex > LOCAL && !sgpd?.entries[e.groupDescriptionIndex - LOCAL - 1]);
    if (bad) out.push(`sbgp '${t}' refers to fragment-local entry ${bad.groupDescriptionIndex - LOCAL}, ${sgpd ? `sgpd has ${sgpd.entries.length}` : 'no sgpd in the traf'}`);
  }
  return out;
}

/** KIDs of protected 'seig' entries anywhere below `boxes` (key rotation). */
export function seigKids(boxes: ParsedIsoBox[]): string[] {
  const out: string[] = [];
  const walk = (bs: ParsedIsoBox[]) => {
    for (const b of bs) {
      const g = b as unknown as SgpdBox;
      if (b.type === 'sgpd' && g.groupingType === 'seig') for (const e of g.entries) if (e.isProtected && typeof e.kid === 'string' && !out.includes(e.kid)) out.push(e.kid);
      walk(childrenOf(b));
    }
  };
  walk(boxes);
  return out;
}
