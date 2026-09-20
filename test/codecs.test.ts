import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedIsoBox, ProtectionSystemSpecificHeaderBox } from '@svta/cml-iso-bmff';
import { drmSystemName, hexUuid, kidsOf } from '../src/codecs';

const uuidBytes = (hex: string) => hex.replace(/-/g, '').match(/../g)!.map((h) => parseInt(h, 16));
const pssh = (systemId: string, fields: Partial<ProtectionSystemSpecificHeaderBox>): ProtectionSystemSpecificHeaderBox =>
  ({ type: 'pssh', version: 0, flags: 0, systemId: uuidBytes(systemId), kidCount: 0, kid: [], dataSize: 0, data: [], ...fields }) as ProtectionSystemSpecificHeaderBox & ParsedIsoBox;

const KID = '0123456789ab-cdef-0123-456789abcdef'.replace('-', ''); // 0123456789abcdef0123456789abcdef
const WV = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const PR = '9a04f079-9840-4286-ab92-e65be0885f95';

test('hexUuid formats 16 bytes as 8-4-4-4-12', () => {
  assert.equal(hexUuid(uuidBytes(WV)), WV);
});

test('drmSystemName knows the common systems', () => {
  assert.equal(drmSystemName(uuidBytes(WV)), 'Widevine');
  assert.equal(drmSystemName(uuidBytes(PR)), 'PlayReady');
  assert.equal(drmSystemName(uuidBytes('94ce86fb-07ff-4f43-adb8-93d2fa968ca2')), 'FairPlay');
  assert.equal(drmSystemName(uuidBytes('1077efec-c0b2-4d02-ace3-3c1e52e2fb4b')), 'ClearKey');
  assert.equal(drmSystemName(uuidBytes('00000000-0000-0000-0000-000000000000')), undefined);
});

test('kidsOf: v1 kid list', () => {
  const kids = kidsOf(pssh(WV, { version: 1, kidCount: 2, kid: [...uuidBytes(KID), ...uuidBytes(KID).reverse()] }));
  assert.deepEqual(kids, ['01234567-89ab-cdef-0123-456789abcdef', 'efcdab89-6745-2301-efcd-ab8967452301']);
});

test('kidsOf: Widevine protobuf key_ids (field 2)', () => {
  // field 1 algorithm varint 1, field 2 key_id (16 bytes), field 4 content_id "abc"
  const data = [0x08, 0x01, 0x12, 0x10, ...uuidBytes(KID), 0x22, 0x03, 0x61, 0x62, 0x63];
  assert.deepEqual(kidsOf(pssh(WV, { data })), ['01234567-89ab-cdef-0123-456789abcdef']);
});

test('kidsOf: PlayReady XML KID (GUID byte order) and 4.x KID VALUE', () => {
  // KID bytes in GUID little-endian order → base64
  const guid = [...uuidBytes(KID)];
  const swapped = [guid[3], guid[2], guid[1], guid[0], guid[5], guid[4], guid[7], guid[6], ...guid.slice(8)];
  const b64 = Buffer.from(swapped).toString('base64');
  const xml = `<WRMHEADER><DATA><KID>${b64}</KID><PROTECTINFO><KIDS><KID ALGID="AESCTR" VALUE="${b64}"></KID></KIDS></PROTECTINFO></DATA></WRMHEADER>`;
  const utf16 = [...Buffer.from(xml, 'utf16le')];
  const data = [...Array(10).fill(0), ...utf16]; // PRO header (10 bytes) then record data
  assert.deepEqual(kidsOf(pssh(PR, { data })), ['01234567-89ab-cdef-0123-456789abcdef']);
});

test('kidsOf: unknown system without v1 kids yields nothing', () => {
  assert.deepEqual(kidsOf(pssh('00000000-0000-0000-0000-000000000000', { data: [1, 2, 3] })), []);
});

import { codecString, trackCodec } from '../src/codecs';
const box = (type: string, fields: Record<string, unknown> = {}, boxes?: unknown[]): ParsedIsoBox =>
  ({ type, ...fields, ...(boxes ? { boxes } : {}) }) as unknown as ParsedIsoBox;

test('codecString: AVC', () => {
  assert.equal(codecString(box('avc1', {}, [box('avcC', { avcProfileIndication: 0x64, profileCompatibility: 0, avcLevelIndication: 0x1f })])), 'avc1.64001F');
  assert.equal(codecString(box('avc3', {}, [box('avcC', { avcProfileIndication: 66, profileCompatibility: 0xc0, avcLevelIndication: 30 })])), 'avc3.42C01E');
});

test('codecString: HEVC per ISO/IEC 14496-15 Annex E', () => {
  const hvcC = { generalProfileSpace: 0, generalTierFlag: 0, generalProfileIdc: 2, generalProfileCompatibilityFlags: 0x20000000, generalConstraintIndicatorFlags: new Uint8Array([0x90, 0, 0, 0, 0, 0]), generalLevelIdc: 93 };
  assert.equal(codecString(box('hvc1', {}, [box('hvcC', hvcC)])), 'hvc1.2.4.L93.90');
  assert.equal(codecString(box('hev1', {}, [box('hvcC', { ...hvcC, generalProfileSpace: 1, generalTierFlag: 1, generalProfileIdc: 1, generalProfileCompatibilityFlags: 0x60000000, generalLevelIdc: 120 })])), 'hev1.A1.6.H120.90');
});

test('codecString: AV1, VP9, AAC, others', () => {
  assert.equal(codecString(box('av01', {}, [box('av1C', { seqProfile: 0, seqLevelIdx0: 8, seqTier0: 0, highBitdepth: 0, twelveBit: 0 })])), 'av01.0.08M.08');
  assert.equal(codecString(box('av01', {}, [box('av1C', { seqProfile: 2, seqLevelIdx0: 13, seqTier0: 1, highBitdepth: 1, twelveBit: 1 })])), 'av01.2.13H.12');
  assert.equal(codecString(box('vp09', {}, [box('vpcC', { profile: 0, level: 31, bitDepth: 8 })])), 'vp09.00.31.08');
  assert.equal(codecString(box('mp4a', {}, [box('esds', { objectTypeIndication: 0x40, audioObjectType: 2 })])), 'mp4a.40.2');
  assert.equal(codecString(box('mp4a', {}, [box('esds', { objectTypeIndication: 0x40, audioObjectType: 29 })])), 'mp4a.40.29');
  assert.equal(codecString(box('mp4a', {}, [box('esds', { objectTypeIndication: 0x6b })])), 'mp4a.6B');
  assert.equal(codecString(box('Opus', {}, [box('dOps')])), 'Opus');
  assert.equal(codecString(box('ec-3')), 'ec-3');
  assert.equal(codecString(box('stpp')), 'stpp');
  assert.equal(codecString(box('avc1')), undefined);
});

test('codecString: encrypted entries use the original format from sinf/frma', () => {
  const encv = box('encv', {}, [box('avcC', { avcProfileIndication: 0x64, profileCompatibility: 0, avcLevelIndication: 0x28 }), box('sinf', {}, [box('frma', { dataFormat: 0x61766331 })])]);
  assert.equal(codecString(encv), 'avc1.640028');
  assert.equal(codecString(box('enca', {}, [box('esds', { objectTypeIndication: 0x40, audioObjectType: 2 }), box('sinf', {}, [box('frma', { dataFormat: 'mp4a' })])])), 'mp4a.40.2');
});

test('trackCodec reads the first stsd entry of a trak', () => {
  const trak = box('trak', {}, [box('mdia', {}, [box('minf', {}, [box('stbl', {}, [box('stsd', { entries: [box('mp4a', {}, [box('esds', { objectTypeIndication: 0x40, audioObjectType: 5 })])] })])])])]);
  assert.equal(trackCodec(trak), 'mp4a.40.5');
  assert.equal(trackCodec(box('trak')), undefined);
});
