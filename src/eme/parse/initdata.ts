import { readIsoBoxes, type ParsedIsoBox, type ProtectionSystemSpecificHeaderBox } from '@svta/cml-iso-bmff';
import { childrenOf } from '../../boxes';
import { drmSystemName, kidsOf } from '../../codecs';
import { readerConfig } from '../../readers';
import { b64ToBytes, hexUuid, kidString, toHex, utf8 } from '../bytes';
import type { ParseResult, PNode } from '../types';
import { parseSkd } from './fairplay';
import { parsePro } from './playready';
import { parsePsshData } from './widevine';

function psshNode(box: ProtectionSystemSpecificHeaderBox): PNode {
  const system = drmSystemName(box.systemId) ?? 'unknown system';
  const data = new Uint8Array(box.data);
  const dataNodes = system === 'Widevine' ? parsePsshData(data) : system === 'PlayReady' ? parsePro(data) : undefined;
  return {
    label: `pssh · ${system}`,
    value: `v${box.version}`,
    children: [
      { label: 'systemId', value: hexUuid(box.systemId) },
      ...kidsOf(box).map((kid) => ({ label: 'KID', value: kid, kid })),
      { label: 'data', value: `${data.length} B`, children: dataNodes ?? (data.length ? [{ label: 'raw', value: toHex(data.subarray(0, 64)) + (data.length > 64 ? '…' : '') }] : undefined) },
    ],
  };
}

function boxNodes(boxes: ParsedIsoBox[]): PNode[] {
  return boxes.map((b) => {
    if (b.type === 'pssh') return psshNode(b as unknown as ProtectionSystemSpecificHeaderBox);
    if (b.type === 'tenc') {
      const kid = hexUuid((b as unknown as { defaultKid: number[] }).defaultKid);
      return { label: 'tenc', value: kid, kid };
    }
    const kids = childrenOf(b);
    return { label: b.type, value: `${b.size} B`, children: kids.length ? boxNodes(kids) : undefined };
  });
}

/** Init data of `encrypted` / `generateRequest`, by initDataType (W3C EME initdata registry + FairPlay `skd`). */
export function parseInitData(type: string | undefined, bytes: Uint8Array): ParseResult {
  const t = (type ?? '').toLowerCase();
  if (t === 'cenc' || t === 'sinf') {
    try {
      const boxes = readIsoBoxes(bytes, readerConfig);
      const systems = boxes.filter((b) => b.type === 'pssh').map((b) => drmSystemName((b as unknown as ProtectionSystemSpecificHeaderBox).systemId) ?? '?');
      return { title: t === 'cenc' ? `cenc init data · ${systems.length} pssh (${systems.join(', ') || 'none'})` : 'sinf init data', nodes: boxNodes(boxes), warnings: [] };
    } catch (e) {
      return { title: `${t} init data`, nodes: [], warnings: [`not parseable as ISOBMFF: ${e instanceof Error ? e.message : String(e)}`] };
    }
  }
  if (t === 'keyids') {
    try {
      const v = JSON.parse(utf8(bytes)) as { kids?: string[] };
      const nodes = (v.kids ?? []).map((k, i) => {
        const kid = kidString(b64ToBytes(k));
        return { label: `kids[${i}]`, value: kid, kid };
      });
      return { title: `keyids init data · ${nodes.length} KID${nodes.length === 1 ? '' : 's'}`, nodes, warnings: [], text: JSON.stringify(v, null, 2) };
    } catch {
      return { title: 'keyids init data', nodes: [], warnings: ['keyids init data is not JSON'] };
    }
  }
  if (t === 'webm') {
    const kid = kidString(bytes);
    return { title: 'webm init data', nodes: [{ label: 'KID', value: kid, kid }], warnings: [] };
  }
  if (t === 'skd') return parseSkd(bytes);
  return { title: `${type ?? 'unknown'} init data`, nodes: [{ label: 'size', value: `${bytes.length} B` }], warnings: [] };
}
