import { b64ToBytes, kidString, toHex, utf8 } from '../bytes';
import type { ParseResult, PNode } from '../types';

const json = (b: Uint8Array): Record<string, unknown> | undefined => {
  try {
    const v = JSON.parse(utf8(b));
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
};

const kidNode = (label: string, b64: unknown): PNode => {
  try {
    const kid = kidString(b64ToBytes(String(b64)));
    return { label, value: kid, kid };
  } catch {
    return { label, value: String(b64), warn: 'not base64url' };
  }
};

/** ClearKey license request (W3C EME 9.1.3): `{ kids: [b64url], type }`. */
export function parseClearKeyRequest(bytes: Uint8Array): ParseResult | undefined {
  const v = json(bytes);
  if (!v || !Array.isArray(v.kids)) return undefined;
  const nodes = [...v.kids.map((k, i) => kidNode(`kids[${i}]`, k)), { label: 'type', value: String(v.type ?? '') }];
  return { title: `ClearKey license request · ${v.kids.length} KID${v.kids.length === 1 ? '' : 's'}`, nodes, warnings: [], text: JSON.stringify(v, null, 2) };
}

/** ClearKey license (JWK set): `{ keys: [{ kty: 'oct', kid, k }], type }`. Keys are in the clear by design. */
export function parseClearKeyResponse(bytes: Uint8Array): ParseResult | undefined {
  const v = json(bytes);
  if (!v || !Array.isArray(v.keys)) return undefined;
  const warnings: string[] = [];
  const nodes: PNode[] = v.keys.map((k: Record<string, unknown>, i: number) => {
    const kid = kidNode('kid', k.kid);
    let key: PNode;
    try {
      const raw = b64ToBytes(String(k.k));
      key = { label: 'k', value: toHex(raw), warn: raw.length === 16 ? undefined : `${raw.length} B key (expected 16)` };
    } catch {
      key = { label: 'k', value: String(k.k), warn: 'not base64url' };
    }
    if (k.kty !== 'oct') warnings.push(`key ${i}: kty "${k.kty}" (expected "oct")`);
    return { label: `keys[${i}]`, value: kid.value, children: [kid, key, { label: 'kty', value: String(k.kty) }] };
  });
  if (v.type !== undefined) nodes.push({ label: 'type', value: String(v.type) });
  return { title: `ClearKey license · ${v.keys.length} key${v.keys.length === 1 ? '' : 's'}`, nodes, warnings, text: JSON.stringify(v, null, 2) };
}

export const isClearKeyJson = (b: Uint8Array): boolean => {
  const v = json(b);
  return !!v && (Array.isArray(v.kids) || Array.isArray(v.keys));
};
