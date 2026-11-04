import { b64ToBytes, decodeText, guidToUuid, toHex, utf8 } from '../bytes';
import type { ParseResult, PNode } from '../types';

// ---------- tolerant XML helpers (namespace prefixes ignored; no DOMParser so this runs in tests) ----------

const NS = '(?:[\\w.-]+:)?';
const re = (name: string, flags = 'i') => new RegExp(`<${NS}${name}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${NS}${name}\\s*>)`, flags);

/** Inner text of the first `<name>` element. */
export const xmlTag = (xml: string, name: string): string | undefined => re(name).exec(xml)?.[2];
export const xmlTags = (xml: string, name: string): { attrs: string; inner: string }[] =>
  [...xml.matchAll(re(name, 'gi'))].map((m) => ({ attrs: m[1] ?? '', inner: m[2] ?? '' }));
export const xmlAttr = (attrs: string, name: string): string | undefined => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)?.[1];
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Line-per-element indentation for display. */
export function prettyXml(xml: string): string {
  let depth = 0;
  return xml
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map((line) => {
      if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
      const out = '  '.repeat(depth) + line;
      if (/^<[^!?/][^>]*[^/]>$/.test(line) && !/<\/[^>]+>$/.test(line)) depth++;
      return out;
    })
    .join('\n');
}

// ---------- WRMHEADER / PlayReady Object ----------

const kidOf = (b64: string): string | undefined => {
  try {
    const g = b64ToBytes(b64);
    return g.length === 16 ? guidToUuid(g) : undefined;
  } catch {
    return undefined;
  }
};

/** KIDs in a WRMHEADER: v4.0 `<KID>b64</KID>` and v4.1+ `<KID VALUE="b64" …>`; base64 in GUID byte order. */
export function wrmHeaderKids(xml: string): string[] {
  const out: string[] = [];
  for (const { attrs, inner } of xmlTags(xml, 'KID')) {
    const kid = kidOf(xmlAttr(attrs, 'VALUE') ?? inner);
    if (kid && !out.includes(kid)) out.push(kid);
  }
  return out;
}

export function parseWrmHeader(xml: string): PNode[] {
  const head = xmlTags(xml, 'WRMHEADER')[0];
  const nodes: PNode[] = [{ label: 'version', value: (head && xmlAttr(head.attrs, 'version')) ?? '?' }];
  for (const { attrs, inner } of xmlTags(xml, 'KID')) {
    const kid = kidOf(xmlAttr(attrs, 'VALUE') ?? inner);
    const extra = ['ALGID', 'CHECKSUM'].map((a) => xmlAttr(attrs, a) && `${a}=${xmlAttr(attrs, a)}`).filter(Boolean).join(' ');
    nodes.push({ label: 'KID', value: `${kid ?? inner}${extra ? `  ${extra}` : ''}`, kid });
  }
  for (const tag of ['ALGID', 'KEYLEN', 'LA_URL', 'LUI_URL', 'DS_ID', 'DECRYPTORSETUP', 'CHECKSUM']) {
    const v = xmlTag(xml.replace(/<KID[\s\S]*?(?:\/>|<\/KID>)/gi, ''), tag);
    if (v !== undefined) nodes.push({ label: tag, value: unescape(v.trim()) });
  }
  const custom = xmlTag(xml, 'CUSTOMATTRIBUTES');
  if (custom !== undefined) nodes.push({ label: 'CUSTOMATTRIBUTES', value: unescape(custom.trim()) });
  return nodes;
}

/** PlayReady Object (pssh data): LE length, record count, records of {type, length, data}. */
export function parsePro(b: Uint8Array): PNode[] | undefined {
  if (b.length < 10) return undefined;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const count = dv.getUint16(4, true);
  const nodes: PNode[] = [{ label: 'length', value: String(dv.getUint32(0, true)) }];
  let pos = 6;
  for (let i = 0; i < count && pos + 4 <= b.length; i++) {
    const type = dv.getUint16(pos, true);
    const len = dv.getUint16(pos + 2, true);
    const data = b.subarray(pos + 4, pos + 4 + len);
    pos += 4 + len;
    if (type === 1) nodes.push({ label: 'WRMHEADER', children: parseWrmHeader(new TextDecoder('utf-16le').decode(data)) });
    else if (type === 3) nodes.push({ label: 'embedded license store', value: `${len} B` });
    else nodes.push({ label: `record type ${type}`, value: `${len} B` });
  }
  return nodes;
}

// ---------- license challenge (CDM message) ----------

const bodyOp = (soap: string) => /<(?:[\w.-]+:)?Body[^>]*>\s*<(?:[\w.-]+:)?([\w-]+)/i.exec(soap)?.[1];

function parseChallengeSoap(soap: string): PNode[] {
  const nodes: PNode[] = [];
  const op = bodyOp(soap);
  if (op) nodes.push({ label: 'operation', value: op });
  const la = xmlTag(soap, 'LA') ?? soap;
  const version = xmlTag(la, 'Version');
  if (version) nodes.push({ label: 'Version', value: version.trim() });
  const header = xmlTags(la, 'WRMHEADER')[0];
  if (header) nodes.push({ label: 'WRMHEADER', children: parseWrmHeader(`<WRMHEADER${header.attrs}>${header.inner}</WRMHEADER>`) });
  const client = xmlTag(la, 'CLIENTVERSION');
  if (client) nodes.push({ label: 'CLIENTVERSION', value: client.trim() });
  const nonce = xmlTag(la, 'LicenseNonce');
  if (nonce) nodes.push({ label: 'LicenseNonce', value: nonce.trim() });
  const time = xmlTag(la, 'ClientTime');
  if (time && /^\d+$/.test(time.trim())) nodes.push({ label: 'ClientTime', value: `${new Date(Number(time.trim()) * 1000).toISOString()} (${time.trim()})` });
  const custom = xmlTag(la, 'CustomData');
  if (custom !== undefined) nodes.push({ label: 'CustomData', value: unescape(custom.trim()) });
  const rev = xmlTags(la, 'RevListInfo').length;
  if (rev) nodes.push({ label: 'RevocationLists', value: `${rev} list${rev === 1 ? '' : 's'}` });
  if (/<(?:[\w.-]+:)?EncryptedData[\s/>]/i.test(la)) nodes.push({ label: 'EncryptedData', value: 'client certificate (encrypted)' });
  return nodes;
}

/** CDM message: `<PlayReadyKeyMessage>` (UTF-16) wrapping a base64 SOAP challenge and the HTTP headers to send, or a bare SOAP challenge. */
export function parsePlayReadyMessage(bytes: Uint8Array): ParseResult | undefined {
  const text = decodeText(bytes);
  if (!text.trimStart().startsWith('<')) return undefined;
  if (/PlayReadyKeyMessage/i.test(text)) {
    const headers = xmlTags(text, 'HttpHeader').map(({ inner }) => ({ label: (xmlTag(inner, 'name') ?? '?').trim(), value: unescape((xmlTag(inner, 'value') ?? '').trim()) }));
    const b64 = xmlTag(text, 'Challenge');
    let soap = '';
    try {
      soap = b64 ? utf8(b64ToBytes(b64)) : '';
    } catch {
      /* not base64 */
    }
    const type = xmlAttr(xmlTags(text, 'PlayReadyKeyMessage')[0]?.attrs ?? '', 'type') ?? '?';
    const nodes: PNode[] = [
      { label: 'type', value: type },
      { label: 'HTTP headers', children: headers },
    ];
    if (soap) nodes.push({ label: 'challenge', children: parseChallengeSoap(soap) });
    return { title: `PlayReady ${type} challenge`, nodes, warnings: soap ? [] : ['no SOAP challenge in key message'], text: prettyXml(soap || text) };
  }
  if (/Envelope/i.test(text)) return { title: `PlayReady ${bodyOp(text) ?? 'SOAP'} challenge`, nodes: parseChallengeSoap(text), warnings: [], text: prettyXml(text) };
  return undefined;
}

// ---------- license response ----------

const XMR_NAMES: Record<number, string> = {
  0x0001: 'OuterContainer',
  0x0002: 'GlobalPolicyContainer',
  0x0003: 'MinimumEnvironment',
  0x0004: 'PlaybackPolicyContainer',
  0x0005: 'OutputProtectionLevelRestriction',
  0x0006: 'UplinkKid',
  0x0007: 'ExplicitAnalogVideoOutputProtectionContainer',
  0x0008: 'AnalogVideoOutputConfiguration',
  0x0009: 'KeyMaterialContainer',
  0x000a: 'ContentKey',
  0x000b: 'Signature',
  0x000c: 'SerialNumber',
  0x000d: 'Rights',
  0x000e: 'CopyPolicyContainer',
  0x0010: 'InclusionList',
  0x0011: 'Priority',
  0x0012: 'Expiration',
  0x0013: 'IssueDate',
  0x0014: 'ExpirationAfterFirstUse',
  0x0015: 'ExpirationAfterFirstStore',
  0x0016: 'Metering',
  0x0017: 'PlayCount',
  0x001a: 'GracePeriod',
  0x0022: 'SourceId',
  0x0025: 'RevocationContainer',
  0x002a: 'EccDeviceKey',
  0x002c: 'PolicyMetadata',
  0x002d: 'OptimizedContentKey',
  0x002e: 'ExplicitDigitalAudioOutputProtectionContainer',
  0x0030: 'ExpirationAfterFirstPlay',
  0x0031: 'DigitalAudioOutputConfiguration',
  0x0032: 'RevocationInfoVersion',
  0x0033: 'EmbeddingBehavior',
  0x0034: 'SecurityLevel',
  0x0036: 'PlayEnablerContainer',
  0x0039: 'PlayEnabler',
  0x003b: 'UplinkKid2',
  0x0041: 'ReadPolicyContainer',
  0x0050: 'RemovalDate',
  0x0051: 'AuxKey',
  0x0052: 'UplinkX',
};
const CONTAINERS = new Set([0x0001, 0x0002, 0x0004, 0x0007, 0x0009, 0x000e, 0x0025, 0x002e, 0x0036, 0x0041]);
const SYMMETRIC_CIPHER: Record<number, string> = { 1: 'AES-128-CTR', 2: 'RC4', 3: 'AES-128-ECB', 4: 'Cocktail', 5: 'AES-128-CBC' };
const KEY_ENCRYPTION: Record<number, string> = { 1: 'RSA-1024', 2: 'ChainedLicense', 3: 'ECC-256', 4: 'ECC-256 with Kz', 5: 'TEE transient', 6: 'ECC-256 via symmetric' };
const SECURITY_LEVELS: Record<number, string> = { 150: 'SL150 (test)', 2000: 'SL2000 (software/TEE)', 3000: 'SL3000 (hardware)' };
const epoch = (s: number) => (s === 0 || s === 0xffffffff ? `none (${s})` : `${new Date(s * 1000).toISOString()} (${s})`);

function xmrLeaf(type: number, b: Uint8Array): Pick<PNode, 'value' | 'children' | 'kid'> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number) => (o + 2 <= b.length ? dv.getUint16(o) : NaN);
  const u32 = (o: number) => (o + 4 <= b.length ? dv.getUint32(o) : NaN);
  switch (type) {
    case 0x000a: {
      const kid = b.length >= 16 ? guidToUuid(b.subarray(0, 16)) : undefined;
      return {
        value: kid,
        kid,
        children: [
          { label: 'KID', value: kid, kid },
          { label: 'cipher', value: `${SYMMETRIC_CIPHER[u16(16)] ?? 'unknown'} (${u16(16)})` },
          { label: 'key encryption', value: `${KEY_ENCRYPTION[u16(18)] ?? 'unknown'} (${u16(18)})` },
          { label: 'key', value: `${u16(20)} B (encrypted)` },
        ],
      };
    }
    case 0x0012:
      return { children: [{ label: 'begin', value: epoch(u32(0)) }, { label: 'end', value: epoch(u32(4)) }] };
    case 0x0013:
      return { value: epoch(u32(0)) };
    case 0x0014:
    case 0x0015:
    case 0x0030:
    case 0x001a:
      return { value: `${u32(0)} s` };
    case 0x0034:
      return { value: `${SECURITY_LEVELS[u16(0)] ?? u16(0)}` };
    case 0x0032:
      return { value: String(u32(0)) };
    case 0x000d:
      return { value: `0x${u16(0).toString(16)}${u16(0) & 1 ? ' (cannot persist)' : ''}` };
    case 0x0005:
      return {
        children: ['compressed digital video', 'uncompressed digital video', 'analog video', 'compressed digital audio', 'uncompressed digital audio'].map((l, i) => ({
          label: `min OPL ${l}`,
          value: String(u16(i * 2)),
        })),
      };
    case 0x0016:
    case 0x0006:
      return b.length >= 16 ? { value: guidToUuid(b.subarray(0, 16)) } : { value: toHex(b) };
    case 0x000b:
      return { value: `type ${u16(0)} · ${u16(2)} B` };
    default:
      return { value: b.length <= 32 ? toHex(b) : `${b.length} B` };
  }
}

function xmrObjects(b: Uint8Array, start: number, end: number, depth: number): PNode[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: PNode[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const flags = dv.getUint16(pos);
    const type = dv.getUint16(pos + 2);
    const len = dv.getUint32(pos + 4);
    if (len < 8 || pos + len > end) break;
    const node: PNode = { label: XMR_NAMES[type] ?? `object 0x${type.toString(16).padStart(4, '0')}` };
    if ((flags & 2 || CONTAINERS.has(type)) && depth < 8) node.children = xmrObjects(b, pos + 8, pos + len, depth + 1);
    else Object.assign(node, xmrLeaf(type, b.subarray(pos + 8, pos + len)));
    out.push(node);
    pos += len;
  }
  return out;
}

/** XMR license: 'XMR\0', version, rights ID GUID, then nested {flags, type, length} objects (big-endian). */
export function parseXmr(b: Uint8Array): PNode[] {
  if (b.length < 24 || String.fromCharCode(b[0], b[1], b[2]) !== 'XMR') return [{ label: 'license', value: `${b.length} B (not XMR)` }];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return [
    { label: 'XMR version', value: String(dv.getUint32(4)) },
    { label: 'rights ID', value: guidToUuid(b.subarray(8, 24)) },
    ...xmrObjects(b, 24, b.length, 0),
  ];
}

/** License server SOAP response: AcquireLicenseResponse with XMR licenses, or a SOAP fault. */
export function parsePlayReadyResponse(bytes: Uint8Array): ParseResult | undefined {
  const text = decodeText(bytes);
  if (!text.trimStart().startsWith('<')) return undefined;
  const nodes: PNode[] = [];
  const warnings: string[] = [];
  const op = bodyOp(text);
  if (op) nodes.push({ label: 'operation', value: op });
  if (/<(?:[\w.-]+:)?Fault[\s/>]/i.test(text)) {
    const code = xmlTag(text, 'faultcode')?.trim();
    const msg = unescape(xmlTag(text, 'faultstring')?.trim() ?? '');
    const status = xmlTag(text, 'StatusCode')?.trim();
    nodes.push({ label: 'faultcode', value: code, warn: 'SOAP fault' }, { label: 'faultstring', value: msg });
    if (status) nodes.push({ label: 'StatusCode', value: status });
    warnings.push(`license server SOAP fault${status ? ` ${status}` : ''}: ${msg || code || 'no message'}`);
  }
  const licenses = xmlTags(text, 'License');
  licenses.forEach(({ inner }, i) => {
    try {
      nodes.push({ label: `License[${i}]`, children: parseXmr(b64ToBytes(inner.trim())) });
    } catch {
      nodes.push({ label: `License[${i}]`, value: 'not base64' });
    }
  });
  for (const tag of ['LicenseNonce', 'ResponseID', 'CustomData']) {
    const v = xmlTag(text, tag);
    if (v !== undefined) nodes.push({ label: tag, value: unescape(v.trim()) });
  }
  const title = warnings.length ? 'PlayReady SOAP fault' : `PlayReady license response · ${licenses.length} license${licenses.length === 1 ? '' : 's'}`;
  return { title, nodes, warnings, text: prettyXml(text) };
}
