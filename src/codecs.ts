import type { ParsedIsoBox, ProtectionSystemSpecificHeaderBox } from '@svta/cml-iso-bmff';
import { hexUuid } from './eme/bytes';
import { decodeProto } from './eme/parse/protobuf';
import { wrmHeaderKids } from './eme/parse/playready';

export { hexUuid };

const DRM_SYSTEMS: Record<string, string> = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'Widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'PlayReady',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'FairPlay',
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'ClearKey',
  '5e629af5-38da-4063-8977-97ffbd9902d4': 'Marlin',
};

export const drmSystemName = (systemId: ArrayLike<number>): string | undefined => DRM_SYSTEMS[hexUuid(systemId)];

/** Widevine PSSH data is a protobuf; key_ids is field 2, 16 bytes each. */
const widevineKids = (data: number[]): string[] =>
  (decodeProto(new Uint8Array(data)) ?? []).flatMap((f) => (f.no === 2 && f.value instanceof Uint8Array && f.value.length === 16 ? [hexUuid(f.value)] : []));

/** PlayReady Object: 10-byte header, then UTF-16LE WRMHEADER XML with base64 KIDs in GUID byte order. */
const playReadyKids = (data: number[]): string[] => wrmHeaderKids(new TextDecoder('utf-16le').decode(new Uint8Array(data.slice(10))));

/** Key IDs named by a pssh: v1 kid list plus those in Widevine/PlayReady payloads, de-duplicated. */
// ponytail: Widevine + PlayReady payloads only
export function kidsOf(pssh: ProtectionSystemSpecificHeaderBox): string[] {
  const out: string[] = [];
  for (let i = 0; i + 16 <= pssh.kid.length; i += 16) out.push(hexUuid(pssh.kid.slice(i, i + 16)));
  const system = drmSystemName(pssh.systemId);
  if (system === 'Widevine') out.push(...widevineKids(pssh.data));
  if (system === 'PlayReady') out.push(...playReadyKids(pssh.data));
  return [...new Set(out)];
}

// ---------- codec strings (RFC 6381 / ISO/IEC 14496-15 Annex E / AV1 & VP codec ISOBMFF bindings) ----------

type Fields = Record<string, unknown>;
const kids = (box: unknown): ParsedIsoBox[] => (box as { boxes?: ParsedIsoBox[] } | undefined)?.boxes ?? [];
const child = (box: unknown, type: string): Fields | undefined => kids(box).find((b) => b.type === type) as Fields | undefined;
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const fourccOf = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String.fromCharCode(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255) : undefined;

/** Reverses the bit order of a 32-bit value (HEVC compatibility flags are written MSB-first). */
const reverse32 = (n: number) => {
  let r = 0;
  for (let i = 0; i < 32; i++) r = (r * 2) | ((n >>> i) & 1);
  return r;
};

/** MIME `codecs=` string of one sample entry, or undefined without a decodable configuration record. */
export function codecString(entry: { type: string }): string | undefined {
  let type: string = entry.type;
  if (type === 'encv' || type === 'enca') type = fourccOf(child(child(entry, 'sinf'), 'frma')?.dataFormat) ?? type;
  const avcC = child(entry, 'avcC');
  const hvcC = child(entry, 'hvcC');
  const av1C = child(entry, 'av1C');
  const vpcC = child(entry, 'vpcC');
  const esds = child(entry, 'esds');
  switch (type) {
    case 'avc1':
    case 'avc2':
    case 'avc3':
    case 'avc4':
      return avcC && `${type}.${hex2(avcC.avcProfileIndication as number)}${hex2(avcC.profileCompatibility as number)}${hex2(avcC.avcLevelIndication as number)}`;
    case 'hvc1':
    case 'hev1': {
      if (!hvcC) return undefined;
      const space = ['', 'A', 'B', 'C'][hvcC.generalProfileSpace as number];
      const compat = reverse32(hvcC.generalProfileCompatibilityFlags as number).toString(16).toUpperCase();
      const tier = hvcC.generalTierFlag ? 'H' : 'L';
      const constraints = Array.from(hvcC.generalConstraintIndicatorFlags as Uint8Array, hex2);
      while (constraints.length > 1 && constraints[constraints.length - 1] === '00') constraints.pop();
      return `${type}.${space}${hvcC.generalProfileIdc}.${compat}.${tier}${hvcC.generalLevelIdc}.${constraints.join('.')}`;
    }
    case 'av01':
      return av1C && `av01.${av1C.seqProfile}.${String(av1C.seqLevelIdx0).padStart(2, '0')}${av1C.seqTier0 ? 'H' : 'M'}.${av1C.highBitdepth ? (av1C.twelveBit ? '12' : '10') : '08'}`;
    case 'vp08':
    case 'vp09':
      return vpcC && `${type}.${String(vpcC.profile).padStart(2, '0')}.${String(vpcC.level).padStart(2, '0')}.${String(vpcC.bitDepth).padStart(2, '0')}`;
    case 'mp4a':
      return esds && `mp4a.${hex2(esds.objectTypeIndication as number)}${esds.audioObjectType !== undefined ? `.${esds.audioObjectType}` : ''}`;
    case 'Opus':
    case 'fLaC':
    case 'ac-3':
    case 'ec-3':
    case 'ac-4':
    case 'stpp':
    case 'wvtt':
    case 'tx3g':
      return type;
    default:
      return undefined;
  }
}

/** Codec string of the first stsd entry under `trak`. */
export function trackCodec(trak: unknown): string | undefined {
  const stsd = child(child(child(child(trak, 'mdia'), 'minf'), 'stbl'), 'stsd');
  const entry = (stsd?.entries as ParsedIsoBox[] | undefined)?.[0];
  return entry && codecString(entry);
}
