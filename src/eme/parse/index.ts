import { decodeText, utf8 } from '../bytes';
import type { KeySystem, ParseResult } from '../types';
import { isClearKeyJson, parseClearKeyRequest, parseClearKeyResponse } from './clearkey';
import { opaque, parseFairPlayCertificate, parseSpc } from './fairplay';
import { parseInitData } from './initdata';
import { parsePlayReadyMessage, parsePlayReadyResponse } from './playready';
import { isWidevineMessage, parseWidevine } from './widevine';

export type PayloadRole = 'initData' | 'message' | 'update' | 'serverCertificate';

/** Key system guessed from the payload itself, for sessions whose MediaKeys origin was not captured. */
export function sniffKeySystem(b: Uint8Array): KeySystem | undefined {
  if (isClearKeyJson(b)) return 'ClearKey';
  if (decodeText(b).trimStart().startsWith('<')) return 'PlayReady';
  if (isWidevineMessage(b)) return 'Widevine';
  return undefined;
}

function raw(title: string, b: Uint8Array, warn?: string): ParseResult {
  const text = utf8(b);
  const isText = /^[\s\x20-\x7e]*$/.test(text.slice(0, 256)) && b.length > 0;
  return { title, nodes: [{ label: 'size', value: `${b.length.toLocaleString()} B` }], warnings: warn ? [warn] : [], text: isText ? text : undefined };
}

/** Decodes one EME payload for display. Never throws; unknown data falls back to a size + text view. */
export function parsePayload(role: PayloadRole, keySystem: KeySystem | undefined, bytes: Uint8Array, initDataType?: string): ParseResult {
  try {
    if (role === 'initData') return parseInitData(initDataType, bytes);
    const ks = keySystem ?? sniffKeySystem(bytes);
    if (role === 'serverCertificate') {
      if (ks === 'FairPlay') return parseFairPlayCertificate(bytes);
      return parseWidevine(bytes) ?? raw('server certificate', bytes);
    }
    switch (ks) {
      case 'Widevine':
        return parseWidevine(bytes) ?? raw('Widevine payload', bytes, 'not a Widevine SignedMessage');
      case 'PlayReady':
        return (role === 'message' ? parsePlayReadyMessage(bytes) : parsePlayReadyResponse(bytes)) ?? raw('PlayReady payload', bytes, 'not PlayReady XML');
      case 'ClearKey':
        return (role === 'message' ? parseClearKeyRequest(bytes) : parseClearKeyResponse(bytes)) ?? raw('ClearKey payload', bytes, 'not ClearKey JSON');
      case 'FairPlay':
        return role === 'message' ? parseSpc(bytes) : opaque('FairPlay CKC', bytes);
      default:
        return raw('payload', bytes);
    }
  } catch (e) {
    return raw('payload', bytes, `decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
