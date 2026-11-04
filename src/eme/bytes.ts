/** Byte helpers shared by the EME parsers and the model. */

export const toHex = (bytes: ArrayLike<number>): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** 16 bytes → 8-4-4-4-12 lowercase. */
export const hexUuid = (bytes: ArrayLike<number>): string => toHex(bytes).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

/** Microsoft GUID byte order (first three groups little-endian) → UUID string. PlayReady stores KIDs this way. */
export const guidToUuid = (g: ArrayLike<number>): string => hexUuid([g[3], g[2], g[1], g[0], g[5], g[4], g[7], g[6], ...Array.from(g).slice(8, 16)]);

/** UUID string with its first three groups byte-swapped (big-endian ⇄ GUID order). */
export const swapUuid = (uuid: string): string => {
  const h = uuid.replace(/-/g, '');
  const sw = (s: string) => s.match(/../g)!.reverse().join('');
  return hexUuid((sw(h.slice(0, 8)) + sw(h.slice(8, 12)) + sw(h.slice(12, 16)) + h.slice(16)).match(/../g)!.map((x) => parseInt(x, 16)));
};

/** 16 bytes → UUID, anything else → hex. */
export const kidString = (bytes: ArrayLike<number>): string => (bytes.length === 16 ? hexUuid(bytes) : toHex(bytes));

/** base64 or base64url (padding optional) → bytes. Throws on invalid input. */
export function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  let n = s.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  while (n.length % 4) n += '=';
  const bin = atob(n);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const utf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

/** UTF-16LE when the bytes look like it (BOM or NUL high bytes), else UTF-8. BOM stripped. */
export function decodeText(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[1] === 0 && b[0] !== 0) return new TextDecoder('utf-16le').decode(b);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return utf8(b.subarray(3));
  return utf8(b);
}

/** All bytes printable ASCII (plus tab/newline). */
export const printable = (b: Uint8Array): boolean => b.length > 0 && b.every((c) => (c >= 0x20 && c < 0x7f) || c === 9 || c === 10 || c === 13);

export function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  if (!needle.length || needle.length > hay.length) return -1;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && indexOf(a, b) === 0;

/**
 * Body text from the DevTools network API back to bytes. HAR request bodies of binary
 * POSTs (Widevine challenges) carry one char per byte, so code points ≤ 0xFF map 1:1;
 * anything else is real text and is UTF-8 encoded.
 */
export function textToBytes(text: string): Uint8Array<ArrayBuffer> {
  let latin1 = true;
  for (let i = 0; i < text.length && latin1; i++) latin1 = text.charCodeAt(i) <= 0xff;
  if (!latin1) return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** Text with U+FFFD: DevTools decoded a binary body as text (e.g. served as text/html), the bytes are gone. */
export const isLossyText = (text: string): boolean => text.includes('\uFFFD');

export const fourccOf = (n: number): string => String.fromCharCode((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
