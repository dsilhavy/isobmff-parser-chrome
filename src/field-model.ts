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
  emsg: (b) =>
    b.version === 1
      ? [['timescale', 4], ['presentationTime', 8], ['eventDuration', 4], ['id', 4], ['schemeIdUri', -1]]
      : [['schemeIdUri', -1]],
};

const STRING_KEYS = new Set(['type', 'majorBrand', 'handlerType', 'compatibleBrands', 'name', 'language', 'schemeIdUri']);
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

/** Muted annotation after a raw value: seconds for time fields, hex for flags, names/UUIDs for DRM ids. */
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
  return undefined;
}
