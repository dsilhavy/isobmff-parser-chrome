const TOP_LEVEL = new Set([
  'ftyp', 'styp', 'moov', 'moof', 'sidx', 'ssix', 'mdat', 'free', 'skip',
  'emsg', 'prft', 'pdin', 'uuid', 'mfra', 'meta',
]);

/** True if the buffer starts with a plausible top-level ISOBMFF box. */
export function isIsoBmff(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false;
  const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (!TOP_LEVEL.has(type)) return false;
  const size =
    (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0;
  if (size === 0) return true; // box extends to end of file
  if (size === 1) return bytes.byteLength >= 16; // 64-bit largesize follows
  return size >= 8 && size <= bytes.byteLength;
}
