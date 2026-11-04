import { decodeText, printable, toHex } from '../bytes';
import type { ParseResult } from '../types';

/**
 * FairPlay SPC (server playback context): the outer header is documented in the FPS server SDK
 * (version, reserved, IV, wrapped AES key, certificate hash, payload length); the payload is encrypted.
 */
export function parseSpc(b: Uint8Array): ParseResult {
  const HEADER = 4 + 4 + 16 + 128 + 20 + 4;
  if (b.length < HEADER) return opaque('FairPlay SPC', b);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const payload = dv.getUint32(172);
  const warnings = payload + HEADER === b.length ? [] : [`SPC payload length ${payload} does not match message size ${b.length}`];
  return {
    title: `FairPlay SPC · v${dv.getUint32(0)}`,
    nodes: [
      { label: 'version', value: String(dv.getUint32(0)) },
      { label: 'SPC data IV', value: toHex(b.subarray(8, 24)) },
      { label: 'wrapped AES key', value: '128 B (RSA, for the key server)' },
      { label: 'certificate hash', value: toHex(b.subarray(152, 172)) },
      { label: 'payload', value: `${payload.toLocaleString()} B (encrypted)` },
    ],
    warnings,
  };
}

/** CKC and other FairPlay blobs: opaque by design. */
export function opaque(title: string, b: Uint8Array): ParseResult {
  return { title, nodes: [{ label: 'size', value: `${b.length.toLocaleString()} B` }, { label: 'note', value: 'FairPlay payloads are encrypted end to end; only sizes are shown' }], warnings: [] };
}

/** setServerCertificate for FairPlay: the application certificate, DER X.509. */
export function parseFairPlayCertificate(b: Uint8Array): ParseResult {
  const der = b[0] === 0x30 && (b[1] & 0x80) !== 0;
  return { title: der ? 'FairPlay application certificate (X.509 DER)' : 'FairPlay certificate', nodes: [{ label: 'size', value: `${b.length.toLocaleString()} B` }], warnings: der ? [] : ['certificate is not DER-encoded X.509'] };
}

/** `skd` init data: the content key URI (skd://…), UTF-8 or UTF-16. */
export function parseSkd(b: Uint8Array): ParseResult {
  const text = decodeText(b).replace(/\0/g, '');
  return { title: 'FairPlay skd init data', nodes: [{ label: 'uri', value: printable(new TextEncoder().encode(text)) ? text : toHex(b) }], warnings: [] };
}
