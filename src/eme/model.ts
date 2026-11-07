import type { ParsedIsoBox, ProtectionSystemSpecificHeaderBox } from '@svta/cml-iso-bmff';
import { seigKids } from '../sample-groups';
import { childrenOf } from '../boxes';
import { kidsOf } from '../codecs';
import { b64ToBytes, bytesToB64, hexUuid, indexOf, kidString, swapUuid } from './bytes';
import { parsePayload, type PayloadRole } from './parse';
import { keySystemOf, kidsIn, type KeySystem, type NetExchange, type ParseResult, type RawEvent } from './types';

export interface Payload {
  role: PayloadRole;
  label: string;
  bytes: Uint8Array;
  parsed: ParseResult;
}

export interface LicenseExchange extends NetExchange {
  matched: 'bytes' | 'timing';
}

/** One EME call (merged with its result) or event, in page order. */
export interface FlowItem {
  id: number; // seq of the call / event
  kind: 'call' | 'event';
  name: string;
  target?: string;
  t: number;
  end?: number;
  status: 'pending' | 'ok' | 'error' | 'event';
  args: unknown[];
  value?: unknown;
  error?: { name: string; message: string };
  keySystem?: KeySystem;
  keySystemName?: string; // the requested string, e.g. com.widevine.alpha
  session?: string;
  payloads: Payload[];
  exchange?: LicenseExchange;
  issues: string[];
}

export interface SessionInfo {
  ref: string;
  keySystem?: KeySystem;
  sessionType: string;
  sessionId?: string;
  mediaKeys?: string;
  keyStatuses: { kid: string; status: string }[];
  expiration?: number;
  closed?: string;
  created: number;
}

export interface SegmentKid {
  kid: string;
  source: 'tenc' | 'pssh' | 'seig';
  url: string;
}

export interface KidInfo {
  kid: string;
  sources: string[]; // tenc, pssh, seig, initData, license, keyStatus
  status?: string;
  urls: string[];
}

export interface EmeModel {
  items: FlowItem[];
  sessions: SessionInfo[];
  kids: KidInfo[];
  issues: string[]; // global (not tied to one item)
}

const refOf = (v: unknown): string | undefined => (v && typeof v === 'object' && typeof (v as { $ref?: unknown }).$ref === 'string' ? (v as { $ref: string }).$ref : undefined);
export const binOf = (v: unknown): Uint8Array | undefined => {
  const b = v && typeof v === 'object' ? (v as { $b64?: unknown }).$b64 : undefined;
  if (typeof b !== 'string') return undefined;
  try {
    return b64ToBytes(b);
  } catch {
    return undefined;
  }
};
const field = (v: unknown, k: string): unknown => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined);

const BAD_STATUS = new Set(['output-restricted', 'output-downscaled', 'internal-error', 'expired']);
const NO_UPDATE_AFTER_MS = 3000;

/** KIDs named by tenc / pssh boxes and protected 'seig' sample groups (key rotation) of captured segments. */
export function segmentKids(segments: { url: string; boxes: ParsedIsoBox[] }[]): SegmentKid[] {
  const out: SegmentKid[] = [];
  const walk = (boxes: ParsedIsoBox[], url: string) => {
    for (const b of boxes) {
      if (b.type === 'tenc') {
        const k = (b as unknown as { defaultKid?: number[] }).defaultKid;
        if (k && k.some((x) => x)) out.push({ kid: hexUuid(k), source: 'tenc', url });
      } else if (b.type === 'pssh') {
        for (const kid of kidsOf(b as unknown as ProtectionSystemSpecificHeaderBox)) out.push({ kid, source: 'pssh', url });
      } else if (b.type === 'sgpd') {
        for (const kid of seigKids([b])) out.push({ kid, source: 'seig', url });
      }
      walk(childrenOf(b), url);
    }
  };
  for (const s of segments) walk(s.boxes, s.url);
  return out;
}

const SLACK_MS = 5; // page clock vs. HAR timestamps

/** Body match: the request carries the message, or the response carries the update() data (raw or base64 inside JSON/SOAP). */
function bodyMatches(x: NetExchange, message: Uint8Array | undefined, update: Uint8Array | undefined): boolean {
  const contains = (hay: Uint8Array | undefined, needle: Uint8Array | undefined) => {
    if (!hay || !needle?.length) return false;
    if (needle.length <= 8 ? hay.length === needle.length && indexOf(hay, needle) === 0 : indexOf(hay, needle) >= 0) return true;
    return needle.length > 8 && indexOf(hay, new TextEncoder().encode(bytesToB64(needle).replace(/=+$/, ''))) >= 0;
  };
  return contains(x.responseBody, update) || contains(x.requestBody, message);
}

export function buildModel(events: RawEvent[], exchanges: NetExchange[], segKids: SegmentKid[], now = Date.now()): EmeModel {
  const items: FlowItem[] = [];
  const byCall = new Map<number, FlowItem>();
  for (const e of events) {
    if (e.kind === 'call' || e.kind === 'event') {
      const item: FlowItem = { id: e.seq, kind: e.kind, name: e.name, target: e.target, t: e.t, status: e.kind === 'event' ? 'event' : 'pending', args: e.args ?? [], value: e.value, payloads: [], issues: [] };
      items.push(item);
      if (e.kind === 'call') byCall.set(e.seq, item);
    } else {
      const item = e.callId !== undefined ? byCall.get(e.callId) : undefined;
      if (!item) continue;
      item.end = e.t;
      item.status = e.kind === 'result' ? 'ok' : 'error';
      if (e.kind === 'result') item.value = e.value;
      else item.error = e.error;
    }
  }

  // ---- object graph: Access → MediaKeys → Session; Media → MediaKeys ----
  const ksName = new Map<string, string>(); // ref → key system string
  const sessions = new Map<string, SessionInfo>();
  const mediaKeysOf = new Map<string, string>(); // Media#n → MediaKeys#n
  for (const it of items) {
    if (it.name === 'requestMediaKeySystemAccess') {
      it.keySystemName = String(it.args[0] ?? '');
      const access = refOf(it.value);
      if (access) ksName.set(access, String(field(it.value, 'keySystem') ?? it.keySystemName));
    } else if (it.name === 'createMediaKeys' && it.target) {
      const mk = refOf(it.value);
      if (mk && ksName.has(it.target)) ksName.set(mk, ksName.get(it.target)!);
    } else if (it.name === 'createSession') {
      const s = refOf(it.value);
      if (s) {
        if (it.target && ksName.has(it.target)) ksName.set(s, ksName.get(it.target)!);
        sessions.set(s, { ref: s, sessionType: String(it.args[0] ?? 'temporary'), mediaKeys: it.target, keyStatuses: [], created: it.t });
      }
    } else if (it.name === 'setMediaKeys' && it.target) {
      const mk = refOf(it.args[0]);
      if (mk) mediaKeysOf.set(it.target, mk);
    }
  }
  const ksFor = (ref: string | undefined) => {
    if (!ref) return undefined;
    return ksName.get(ref) ?? (ref.startsWith('Media#') ? ksName.get(mediaKeysOf.get(ref) ?? '') : undefined);
  };

  // ---- per item: key system, session, payloads ----
  for (const it of items) {
    it.keySystemName ??= ksFor(it.target) ?? (it.name === 'createSession' ? ksFor(refOf(it.value)) : undefined);
    it.keySystem = keySystemOf(it.keySystemName);
    it.session = it.target?.startsWith('Session#') ? it.target : it.name === 'createSession' ? refOf(it.value) : undefined;
    const add = (role: PayloadRole, label: string, v: unknown, initDataType?: string) => {
      const bytes = binOf(v);
      if (bytes) it.payloads.push({ role, label, bytes, parsed: parsePayload(role, it.keySystem, bytes, initDataType) });
    };
    if (it.name === 'generateRequest') add('initData', `initData (${it.args[0]})`, it.args[1], String(it.args[0]));
    else if (it.name === 'encrypted') add('initData', `initData (${field(it.value, 'initDataType')})`, field(it.value, 'initData'), String(field(it.value, 'initDataType')));
    else if (it.name === 'message') add('message', `message (${field(it.value, 'messageType')})`, field(it.value, 'message'));
    else if (it.name === 'update') add('update', 'response', it.args[0]);
    else if (it.name === 'setServerCertificate') add('serverCertificate', 'server certificate', it.args[0]);
    for (const p of it.payloads) it.issues.push(...p.parsed.warnings);
    if (it.status === 'error' && it.error) it.issues.push(`${it.name} rejected: ${it.error.name}: ${it.error.message}`);
  }

  // ---- sessions ----
  for (const it of items) {
    const s = it.session ? sessions.get(it.session) : undefined;
    if (!s) continue;
    s.keySystem ??= it.keySystem;
    const sid = field(it.value, 'sessionId');
    if (typeof sid === 'string' && sid) s.sessionId = sid;
    if (it.name === 'keystatuseschange') {
      const statuses = (field(it.value, 'keyStatuses') as { kid: unknown; status: string }[] | undefined) ?? [];
      s.keyStatuses = statuses.map((k) => ({ kid: kidString(binOf(k.kid) ?? new Uint8Array()), status: k.status }));
      const exp = field(it.value, 'expiration');
      if (typeof exp === 'number') s.expiration = exp;
      for (const k of s.keyStatuses) if (BAD_STATUS.has(k.status)) it.issues.push(`key ${k.kid}: ${k.status}`);
    }
    if (it.name === 'closed') s.closed = String(field(it.value, 'reason') ?? 'closed');
  }

  // ---- license exchanges: message → network → update ----
  // The license request starts after the message and before update() is called. Body matches are
  // assigned first across all messages; the rest take the earliest unused POST in their window.
  const windows = items.flatMap((it, i) => {
    if (it.name !== 'message' || !it.session) return [];
    const update = items.slice(i + 1).find((x) => x.name === 'update' && x.session === it.session);
    const later = items.slice(i + 1).find((x) => x.name === 'message' && x.session === it.session);
    return [{ it, update, later, from: it.t - SLACK_MS, to: (update?.t ?? later?.t ?? Infinity) + SLACK_MS }];
  });
  const used = new Set<NetExchange>();
  const inWindow = (w: (typeof windows)[number]) => exchanges.filter((x) => !used.has(x) && x.method === 'POST' && x.started >= w.from && x.started <= w.to);
  const assign = (w: (typeof windows)[number], x: NetExchange, matched: LicenseExchange['matched']) => {
    used.add(x);
    w.it.exchange = { ...x, matched };
    if (w.update) w.update.exchange = w.it.exchange;
  };
  for (const w of windows) {
    const hit = inWindow(w).find((x) => bodyMatches(x, w.it.payloads[0]?.bytes, w.update?.payloads[0]?.bytes));
    if (hit) assign(w, hit, 'bytes');
  }
  for (const w of windows) {
    if (w.it.exchange) continue;
    const hit = inWindow(w).sort((a, b) => a.started - b.started)[0];
    if (hit) assign(w, hit, 'timing');
  }
  for (const { it, update, later } of windows) {
    if (it.exchange && (it.exchange.status === 0 || it.exchange.status >= 400)) it.issues.push(`license request ${it.exchange.status || 'failed'} ${it.exchange.statusText} (${it.exchange.url})`);
    if (!update && !later && now - it.t > NO_UPDATE_AFTER_MS) it.issues.push(`no update() after this ${String(field(it.value, 'messageType') ?? 'message')} on ${it.session}`);
  }

  // ---- waitingforkey with no usable key afterwards ----
  for (const [i, it] of items.entries()) {
    if (it.name !== 'waitingforkey') continue;
    const usable = items.slice(i + 1).some((x) => x.name === 'keystatuseschange' && ((field(x.value, 'keyStatuses') as { status: string }[] | undefined) ?? []).some((k) => k.status === 'usable'));
    if (!usable) it.issues.push('playback is waiting for a key and no usable key status followed');
  }

  // ---- granted configuration ----
  for (const it of items) {
    if (it.name !== 'requestMediaKeySystemAccess' || it.status !== 'ok' || it.keySystem !== 'Widevine') continue;
    const caps = [...((field(field(it.value, 'configuration'), 'videoCapabilities') as unknown[]) ?? []), ...((field(field(it.value, 'configuration'), 'audioCapabilities') as unknown[]) ?? [])];
    if (caps.some((c) => !field(c, 'robustness'))) it.issues.push('granted configuration has capabilities without a robustness level (Chrome defaults to SW_SECURE_CRYPTO)');
  }

  // ---- KIDs across segments, init data, licenses and key statuses ----
  const kidMap = new Map<string, KidInfo>();
  const note = (kid: string, source: string, url?: string, status?: string) => {
    const k = kidMap.get(kid) ?? { kid, sources: [], urls: [] };
    if (!k.sources.includes(source)) k.sources.push(source);
    if (url && !k.urls.includes(url)) k.urls.push(url);
    if (status) k.status = status;
    kidMap.set(kid, k);
  };
  for (const s of segKids) note(s.kid, s.source, s.url);
  for (const it of items) {
    for (const p of it.payloads) for (const kid of kidsIn(p.parsed.nodes)) note(kid, p.role === 'update' ? 'license' : p.role === 'message' ? 'request' : 'initData');
  }
  const keyed = new Set<string>();
  for (const s of sessions.values()) {
    for (const k of s.keyStatuses) {
      // Some PlayReady CDMs report key IDs in GUID byte order: fold onto the big-endian KID when that one is known.
      const kid = !kidMap.has(k.kid) && kidMap.has(swapUuid(k.kid)) ? swapUuid(k.kid) : k.kid;
      note(kid, kid === k.kid ? 'keyStatus' : 'keyStatus (GUID byte order)', undefined, k.status);
      keyed.add(kid);
    }
  }
  for (const it of items) for (const p of it.payloads) if (p.role === 'update') for (const kid of kidsIn(p.parsed.nodes)) keyed.add(kid);

  const issues: string[] = [];
  if (keyed.size) {
    for (const k of kidMap.values()) {
      const inSegments = k.sources.filter((s) => s === 'tenc' || s === 'pssh' || s === 'seig');
      if (keyed.has(k.kid) || !inSegments.length) continue;
      issues.push(`KID ${k.kid} (${inSegments.join('/')} in captured segments) is not in any license or key status`);
    }
  }
  return { items, sessions: [...sessions.values()], kids: [...kidMap.values()], issues };
}

const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization)$|token|key|secret|auth|session|jwt|custom-?data/i;

/** Header list with credentials masked, for anything written to disk. */
export const redactHeaders = (headers: { name: string; value: string }[]) => headers.map((h) => (SENSITIVE_HEADER.test(h.name) ? { name: h.name, value: '[redacted]' } : h));

/**
 * Contents of eme-log.json: the raw hook events plus only the network exchanges matched to a
 * license message, with credential headers redacted. Unrelated POSTs (logins, analytics) are left out.
 */
export function exportLog(events: RawEvent[], model: EmeModel): object {
  const seen = new Set<string>();
  const exchanges = model.items.flatMap((it) => {
    const x = it.name === 'message' ? it.exchange : undefined;
    const key = x && `${x.started}|${x.url}`;
    if (!x || seen.has(key!)) return [];
    seen.add(key!);
    return [
      {
        message: it.id,
        ...x,
        requestHeaders: redactHeaders(x.requestHeaders),
        responseHeaders: redactHeaders(x.responseHeaders),
        requestBody: x.requestBody && bytesToB64(x.requestBody),
        responseBody: x.responseBody && bytesToB64(x.responseBody),
      },
    ];
  });
  return { note: 'credential headers redacted; only license exchanges matched to a CDM message are included', events, exchanges };
}
