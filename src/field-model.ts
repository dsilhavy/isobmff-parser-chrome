import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import { drmSystemName, hexUuid } from './codecs';

export interface FieldRange {
  key: string;
  start: number; // relative to the box start
  end: number; // exclusive
  type: string;
}

type Fields = Record<string, unknown> & { version?: number; flags?: number };
/** [key, byte length]: 0 = absent for this version/flags, -1 = to the end of the box. */
type Layout = (b: Fields) => [string, number][];

const v = (b: Fields) => (b.version === 1 ? 8 : 4);
const opt = (b: Fields, bit: number, size: number) => ((b.flags ?? 0) & bit ? size : 0);

// ponytail: hand-written layouts for the boxes people actually inspect; others get header + version/flags only
const LAYOUTS: Record<string, Layout> = {
  tfdt: (b) => [['baseMediaDecodeTime', v(b)]],
  mfhd: () => [['sequenceNumber', 4]],
  tfhd: (b) => [
    ['trackId', 4],
    ['baseDataOffset', opt(b, 1, 8)],
    ['sampleDescriptionIndex', opt(b, 2, 4)],
    ['defaultSampleDuration', opt(b, 8, 4)],
    ['defaultSampleSize', opt(b, 16, 4)],
    ['defaultSampleFlags', opt(b, 32, 4)],
  ],
  trun: (b) => [['sampleCount', 4], ['dataOffset', opt(b, 1, 4)], ['firstSampleFlags', opt(b, 4, 4)], ['samples', -1]],
  trex: () => [['trackId', 4], ['defaultSampleDescriptionIndex', 4], ['defaultSampleDuration', 4], ['defaultSampleSize', 4], ['defaultSampleFlags', 4]],
  mdhd: (b) => [['creationTime', v(b)], ['modificationTime', v(b)], ['timescale', 4], ['duration', v(b)], ['language', 2], ['preDefined', 2]],
  mvhd: (b) => [
    ['creationTime', v(b)], ['modificationTime', v(b)], ['timescale', 4], ['duration', v(b)],
    ['rate', 4], ['volume', 2], ['reserved1', 2], ['reserved2', 8], ['matrix', 36], ['preDefined', 24], ['nextTrackId', 4],
  ],
  tkhd: (b) => [
    ['creationTime', v(b)], ['modificationTime', v(b)], ['trackId', 4], ['reserved1', 4], ['duration', v(b)],
    ['reserved2', 8], ['layer', 2], ['alternateGroup', 2], ['volume', 2], ['reserved3', 2], ['matrix', 36], ['width', 4], ['height', 4],
  ],
  sidx: (b) => [['referenceId', 4], ['timescale', 4], ['earliestPresentationTime', v(b)], ['firstOffset', v(b)], ['reserved', 2], ['referenceCount', 2], ['references', -1]],
  ftyp: () => [['majorBrand', 4], ['minorVersion', 4], ['compatibleBrands', -1]],
  styp: () => [['majorBrand', 4], ['minorVersion', 4], ['compatibleBrands', -1]],
  hdlr: () => [['preDefined', 4], ['handlerType', 4], ['reserved', 12], ['name', -1]],
  elst: () => [['entryCount', 4], ['entries', -1]],
  btrt: () => [['bufferSizeDB', 4], ['maxBitrate', 4], ['avgBitrate', 4]],
  pasp: () => [['hSpacing', 4], ['vSpacing', 4]],
  clap: () => [
    ['cleanApertureWidthN', 4], ['cleanApertureWidthD', 4], ['cleanApertureHeightN', 4], ['cleanApertureHeightD', 4],
    ['horizOffN', 4], ['horizOffD', 4], ['vertOffN', 4], ['vertOffD', 4],
  ],
  colr: (b) =>
    b.colourType === 'nclx' || b.colourType === 'nclc'
      ? [['colourType', 4], ['colourPrimaries', 2], ['transferCharacteristics', 2], ['matrixCoefficients', 2], ['fullRangeFlag', b.fullRangeFlag === undefined ? 0 : 1]]
      : [['colourType', 4], ['iccProfile', -1]],
  clli: () => [['maxContentLightLevel', 2], ['maxPicAverageLightLevel', 2]],
  mdcv: () => [['displayPrimaries', 12], ['whitePointX', 2], ['whitePointY', 2], ['maxDisplayMasteringLuminance', 4], ['minDisplayMasteringLuminance', 4]],
  emsg: (b) =>
    b.version === 1
      ? [['timescale', 4], ['presentationTime', 8], ['eventDuration', 4], ['id', 4], ['schemeIdUri', -1]]
      : [['schemeIdUri', -1]],
};

const STRING_KEYS = new Set(['type', 'colourType', 'majorBrand', 'handlerType', 'compatibleBrands', 'name', 'language', 'schemeIdUri']);
const SIGNED_KEYS = new Set(['dataOffset', 'mediaTime']);

function typeOf(key: string, size: number): string {
  if (size < 0 || size > 8) return STRING_KEYS.has(key) ? 'str' : 'bytes';
  if (STRING_KEYS.has(key)) return 'str';
  return `${SIGNED_KEYS.has(key) ? 'i' : 'u'}${size * 8}`;
}

/** Byte ranges of the header and the decoded fields of `box`, relative to its first byte. */
export function fieldOffsets(box: ParsedIsoBox): FieldRange[] {
  const b = box as unknown as Fields & { largesize?: number; usertype?: unknown };
  const total = b.largesize ?? box.size;
  const out: FieldRange[] = [];
  let pos = 0;
  const push = (key: string, size: number) => {
    if (size === 0) return;
    const end = size < 0 ? total : pos + size;
    out.push({ key, start: pos, end, type: typeOf(key, size) });
    pos = end;
  };
  push('size', 4);
  push('type', 4);
  if (b.largesize !== undefined) push('largesize', 8);
  if (b.usertype !== undefined) push('usertype', 16);
  if (typeof b.version === 'number' && typeof b.flags === 'number') {
    push('version', 1);
    push('flags', 3);
    out[out.length - 1].type = 'u24';
  }
  for (const [key, size] of LAYOUTS[box.type]?.(b) ?? []) {
    if (pos >= total && size !== 0) break;
    push(key, size);
  }
  return out;
}

const TIME_KEYS = new Set([
  'baseMediaDecodeTime', 'duration', 'defaultSampleDuration', 'sampleDuration', 'earliestPresentationTime',
  'subsegmentDuration', 'segmentDuration', 'mediaTime', 'presentationTime', 'presentationTimeDelta', 'eventDuration',
  'sampleCompositionTimeOffset',
]);

const UUID_KEYS = new Set(['kid', 'defaultKid']);

// ITU-T H.273 code points (colr nclx, vpcC)
const PRIMARIES: Record<number, string> = { 1: 'BT.709', 2: 'unspecified', 4: 'BT.470 M', 5: 'BT.601 625', 6: 'BT.601 525', 7: 'SMPTE 240M', 8: 'generic film', 9: 'BT.2020 / BT.2100', 10: 'SMPTE ST 428 (XYZ)', 11: 'DCI-P3', 12: 'Display P3', 22: 'EBU 3213' };
const TRANSFER: Record<number, string> = {
  1: 'BT.709', 2: 'unspecified', 4: 'gamma 2.2', 5: 'gamma 2.8', 6: 'BT.601', 7: 'SMPTE 240M', 8: 'linear', 9: 'log 100:1', 10: 'log 316:1',
  11: 'IEC 61966-2-4', 12: 'BT.1361', 13: 'sRGB', 14: 'BT.2020 10-bit', 15: 'BT.2020 12-bit', 16: 'PQ (SMPTE ST 2084) · HDR', 17: 'SMPTE ST 428', 18: 'HLG (ARIB STD-B67) · HDR',
};
const MATRIX: Record<number, string> = { 0: 'identity (RGB)', 1: 'BT.709', 2: 'unspecified', 4: 'FCC', 5: 'BT.470 BG', 6: 'BT.601', 7: 'SMPTE 240M', 8: 'YCgCo', 9: 'BT.2020 non-constant', 10: 'BT.2020 constant', 11: 'SMPTE ST 2085', 12: 'chroma-derived non-constant', 13: 'chroma-derived constant', 14: 'ICtCp' };
// ETSI TS 102 366 (dac3/dec3)
const ACMOD = ['1+1 (dual mono)', '1/0 (mono)', '2/0 (stereo)', '3/0', '2/1', '3/1', '2/2', '3/2'];
const FSCOD = ['48 kHz', '44.1 kHz', '32 kHz'];
const BSMOD = ['main', 'music and effects', 'visually impaired', 'hearing impaired', 'dialogue', 'commentary', 'emergency', 'voice over / karaoke'];
const AC3_KBPS = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];
const DV_COMPAT: Record<number, string> = { 0: 'none', 1: 'HDR10', 2: 'SDR', 4: 'HLG', 6: 'BT.1886 (Blu-ray)' };
// ISO/IEC 14496-12 Annex I
const SAP_TYPES: Record<number, string> = { 1: 'closed GOP, decode order = presentation order', 2: 'closed GOP, reordered', 3: 'open GOP: leading pictures not decodable', 4: 'gradual decoding refresh (GDR)', 5: 'undecodable picture after T_DEC (T_DEC earliest from I_SAU)', 6: 'undecodable picture after T_DEC (T_DEC not earliest)' };
const kbps = (n: number) => `${(n / 1000).toLocaleString()} kbit/s`;

/** Names for code points and units, by field name. */
const NAMED: Record<string, (n: number) => string | undefined> = {
  colourPrimaries: (n) => PRIMARIES[n],
  transferCharacteristics: (n) => TRANSFER[n],
  matrixCoefficients: (n) => MATRIX[n],
  fullRangeFlag: (n) => (n ? 'full range' : 'limited (video) range'),
  acmod: (n) => ACMOD[n],
  fscod: (n) => FSCOD[n],
  bsmod: (n) => BSMOD[n],
  lfeon: (n) => (n ? '+ LFE' : 'no LFE'),
  bitRateCode: (n) => (AC3_KBPS[n] ? `${AC3_KBPS[n]} kbit/s` : undefined),
  dataRate: (n) => `${n} kbit/s`,
  flagEc3ExtensionTypeA: (n) => (n ? 'Dolby Atmos (JOC)' : undefined),
  dvBlSignalCompatibilityId: (n) => DV_COMPAT[n],
  sapType: (n) => SAP_TYPES[n],
  drapType: (n) => SAP_TYPES[n],
  rollDistance: (n) => (n < 0 ? `${-n} sample${n === -1 ? '' : 's'} before must be decoded` : `correct after ${n} sample${n === 1 ? '' : 's'}`),
  isProtected: (n) => (n ? 'encrypted' : 'clear'),
  maxBitrate: kbps,
  avgBitrate: kbps,
  maxDisplayMasteringLuminance: (n) => `${n / 10000} cd/m²`,
  minDisplayMasteringLuminance: (n) => `${n / 10000} cd/m²`,
  maxContentLightLevel: (n) => `${n} cd/m²`,
  maxPicAverageLightLevel: (n) => `${n} cd/m²`,
  whitePointX: (n) => `x = ${(n * 0.00002).toFixed(4)}`,
  whitePointY: (n) => `y = ${(n * 0.00002).toFixed(4)}`,
};

/** Muted annotation after a raw value: seconds for time fields, hex for flags, names/UUIDs for DRM ids, code point names. */
export function derived(key: string, value: unknown, timescale: number | undefined): string | undefined {
  if (Array.isArray(value) && value.length && value.length % 16 === 0 && (key === 'systemId' || UUID_KEYS.has(key))) {
    const uuids: string[] = [];
    for (let i = 0; i < value.length; i += 16) uuids.push(hexUuid(value.slice(i, i + 16)));
    const name = key === 'systemId' ? drmSystemName(value) : undefined;
    return name ? `${name} · ${uuids[0]}` : uuids.join(', ');
  }
  if (typeof value !== 'number') return undefined;
  if (key === 'flags') return `0x${value.toString(16).padStart(6, '0')}`;
  if (TIME_KEYS.has(key) && timescale) return `= ${(value / timescale).toFixed(3)} s @ ${timescale} Hz`;
  return NAMED[key]?.(value);
}
