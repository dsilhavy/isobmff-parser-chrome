/** One record from the page hook (`src/eme/hook.ts`). Binary values are `{ $b64 }`, EME objects `{ $ref: 'Session#1' }`. */
export interface RawEvent {
  seq: number;
  t: number; // epoch ms in the page
  kind: 'call' | 'result' | 'error' | 'event';
  name: string;
  target?: string; // Access#n, MediaKeys#n, Session#n, Media#n
  callId?: number; // result/error → seq of the call
  args?: unknown[];
  value?: unknown;
  error?: { name: string; message: string };
}

export interface Header {
  name: string;
  value: string;
}

/** A POST seen by `chrome.devtools.network`, candidate for a license/certificate exchange. */
export interface NetExchange {
  url: string;
  method: string;
  status: number;
  statusText: string;
  started: number; // epoch ms
  duration: number; // ms
  requestHeaders: Header[];
  responseHeaders: Header[];
  requestBody?: Uint8Array;
  responseBody?: Uint8Array;
  responseLossy?: boolean; // binary response delivered as text by DevTools; body not recoverable
  mimeType?: string;
}

/** Node of a decoded payload. `kid` marks a key ID (UUID) the UI can cross-link. */
export interface PNode {
  label: string;
  value?: string;
  kid?: string;
  warn?: string;
  children?: PNode[];
}

export interface ParseResult {
  title: string;
  nodes: PNode[];
  warnings: string[];
  text?: string; // pretty XML/JSON of the payload, when it is text
}

export type KeySystem = 'Widevine' | 'PlayReady' | 'ClearKey' | 'FairPlay';

export function keySystemOf(name: string | undefined): KeySystem | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  if (n.includes('widevine')) return 'Widevine';
  if (n.includes('playready')) return 'PlayReady';
  if (n.includes('clearkey')) return 'ClearKey';
  if (n.includes('com.apple.fps') || n.includes('fairplay')) return 'FairPlay';
  return undefined;
}

/** KIDs (deduplicated, in order) named anywhere in a node tree. */
export function kidsIn(nodes: PNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kid && !out.includes(n.kid)) out.push(n.kid);
    if (n.children) kidsIn(n.children, out);
  }
  return out;
}
