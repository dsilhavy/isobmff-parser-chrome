import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookSource } from '../src/eme/hook';
import { buildModel, segmentKids } from '../src/eme/model';
import type { NetExchange, RawEvent } from '../src/eme/types';

const KID = '01234567-89ab-cdef-0123-456789abcdef';
const OTHER = 'fedcba98-7654-3210-fedc-ba9876543210';
const kidBytes = (u: string) => Uint8Array.from(u.replace(/-/g, '').match(/../g)!.map((h) => parseInt(h, 16)));
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const LICENSE = enc({ keys: [{ kty: 'oct', kid: b64url(kidBytes(KID)), k: b64url(kidBytes(OTHER)) }], type: 'temporary' });

// ---------- fake EME environment (ClearKey-like CDM) ----------

const g = globalThis as any;
class MediaKeySession extends EventTarget {
  sessionId = '';
  expiration = NaN;
  keyStatuses = new Map<ArrayBuffer, string>();
  closed = new Promise<string>(() => undefined);
  generateRequest(_type: string, _init: BufferSource) {
    this.sessionId = 'sid-1';
    const message = enc({ kids: [b64url(kidBytes(KID))], type: 'temporary' });
    queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('message'), { messageType: 'license-request', message: message.buffer })));
    return Promise.resolve();
  }
  update(_r: BufferSource) {
    this.keyStatuses.set(kidBytes(KID).buffer, 'usable');
    queueMicrotask(() => this.dispatchEvent(new Event('keystatuseschange')));
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}
class MediaKeys {
  createSession() {
    return new MediaKeySession();
  }
}
class MediaKeySystemAccess {
  keySystem = 'org.w3.clearkey';
  getConfiguration() {
    return { initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"', robustness: '' }] };
  }
  createMediaKeys() {
    return Promise.resolve(new MediaKeys());
  }
}
class Navigator {
  requestMediaKeySystemAccess(ks: string) {
    return ks === 'org.w3.clearkey' ? Promise.resolve(new MediaKeySystemAccess()) : Promise.reject(Object.assign(new Error('Unsupported keySystem'), { name: 'NotSupportedError' }));
  }
}
class HTMLMediaElement extends EventTarget {
  setMediaKeys(_keys: MediaKeys | null) {
    return Promise.resolve();
  }
}
Object.assign(g, { MediaKeySession, MediaKeys, MediaKeySystemAccess, Navigator, HTMLMediaElement });

const tick = () => new Promise((r) => setTimeout(r, 0));

test('hook (serialised via toString) records the EME flow and the model rebuilds it', async () => {
  // the panel injects the function's source text, so it must work without any module scope
  new Function(hookSource())(); // our own source text, not external input
  const nav = new Navigator();
  const video = new HTMLMediaElement();
  video.addEventListener('encrypted', () => undefined); // page listener → hook attaches its own

  await nav.requestMediaKeySystemAccess('com.widevine.alpha').catch(() => undefined);
  const access = await nav.requestMediaKeySystemAccess('org.w3.clearkey');
  const keys = await access.createMediaKeys();
  await video.setMediaKeys(keys);
  video.dispatchEvent(Object.assign(new Event('encrypted'), { initDataType: 'keyids', initData: enc({ kids: [b64url(kidBytes(KID))] }).buffer }));
  const session = keys.createSession();
  await session.generateRequest('keyids', new Uint8Array(4));
  await tick();
  const updateStart = Date.now();
  await session.update(LICENSE);
  await tick();

  const log: RawEvent[] = g.__emeLog.drain(0);
  assert.equal(typeof g.__emeLog.instance, 'string');
  assert.ok(log.every((e, i) => e.seq === log[0].seq + i), 'consecutive seq');
  // JSON round trip, as through inspectedWindow.eval
  const events: RawEvent[] = JSON.parse(JSON.stringify(log));

  const exchange: NetExchange = {
    url: 'https://license.example/clearkey',
    method: 'POST',
    status: 200,
    statusText: 'OK',
    started: updateStart - 1,
    duration: 12,
    requestHeaders: [],
    responseHeaders: [],
    responseBody: LICENSE,
  };
  const model = buildModel(events, [exchange], [
    { kid: KID, source: 'tenc', url: 'https://cdn.example/init.mp4' },
    { kid: OTHER, source: 'pssh', url: 'https://cdn.example/init.mp4' },
  ]);

  const names = model.items.map((i) => i.name);
  assert.deepEqual(names, [
    'hook installed',
    'requestMediaKeySystemAccess',
    'requestMediaKeySystemAccess',
    'createMediaKeys',
    'setMediaKeys',
    'encrypted',
    'createSession',
    'generateRequest',
    'message',
    'update',
    'keystatuseschange',
  ]);
  const [, rejected, granted] = model.items;
  assert.equal(rejected.status, 'error');
  assert.match(rejected.issues[0], /NotSupportedError: Unsupported keySystem/);
  assert.equal(granted.keySystem, 'ClearKey');

  const message = model.items.find((i) => i.name === 'message')!;
  assert.equal(message.session, 'Session#1');
  assert.equal(message.keySystem, 'ClearKey');
  assert.equal(message.payloads[0].parsed.title, 'ClearKey license request · 1 KID');
  assert.equal(message.exchange?.matched, 'bytes');

  const update = model.items.find((i) => i.name === 'update')!;
  assert.equal(update.payloads[0].parsed.title, 'ClearKey license · 1 key');
  assert.equal(update.exchange?.url, exchange.url);

  const encrypted = model.items.find((i) => i.name === 'encrypted')!;
  assert.equal(encrypted.target, 'Media#1');
  assert.equal(encrypted.keySystem, 'ClearKey'); // via setMediaKeys(Media#1 → MediaKeys#1)

  assert.deepEqual(model.sessions.map((s) => [s.ref, s.keySystem, s.sessionId, s.keyStatuses.map((k) => `${k.kid}=${k.status}`).join()]), [['Session#1', 'ClearKey', 'sid-1', `${KID}=usable`]]);
  const kid = model.kids.find((k) => k.kid === KID)!;
  assert.deepEqual(kid.sources.sort(), ['initData', 'keyStatus', 'license', 'request', 'tenc']);
  assert.deepEqual(model.issues, [`KID ${OTHER} (pssh in captured segments) is not in any license or key status`]);
});

test('model checks: failed license POST, missing update, bad key status, PlayReady GUID order', () => {
  const t = 1_000_000;
  const ev = (seq: number, e: Partial<RawEvent>): RawEvent => ({ seq, t: t + seq * 10, kind: 'event', name: '', ...e }) as RawEvent;
  const swapped = '67452301-ab89-efcd-0123-456789abcdef'; // KID in GUID byte order
  const guid = Uint8Array.from(swapped.replace(/-/g, '').match(/../g)!.map((h) => parseInt(h, 16)));
  const events: RawEvent[] = [
    ev(1, { kind: 'call', name: 'requestMediaKeySystemAccess', args: ['com.microsoft.playready.recommendation'] }),
    ev(2, { kind: 'result', name: 'requestMediaKeySystemAccess', callId: 1, value: { $ref: 'Access#1', keySystem: 'com.microsoft.playready.recommendation' } }),
    ev(3, { kind: 'call', name: 'createMediaKeys', target: 'Access#1' }),
    ev(4, { kind: 'result', name: 'createMediaKeys', target: 'Access#1', callId: 3, value: { $ref: 'MediaKeys#1' } }),
    ev(5, { kind: 'call', name: 'createSession', target: 'MediaKeys#1', args: [] }),
    ev(6, { kind: 'result', name: 'createSession', target: 'MediaKeys#1', callId: 5, value: { $ref: 'Session#1' } }),
    ev(7, { name: 'message', target: 'Session#1', value: { messageType: 'license-request', message: { $b64: Buffer.from('<x/>').toString('base64') } } }),
    ev(8, { name: 'keystatuseschange', target: 'Session#1', value: { keyStatuses: [{ kid: { $b64: Buffer.from(guid).toString('base64') }, status: 'output-restricted' }] } }),
  ];
  const failed: NetExchange = { url: 'https://pr.example/rightsmanager.asmx', method: 'POST', status: 500, statusText: 'Internal Server Error', started: t + 75, duration: 5, requestHeaders: [], responseHeaders: [] };
  const segs = segmentKids([{ url: 'init.mp4', boxes: [{ type: 'moov', boxes: [{ type: 'tenc', defaultKid: Array.from(kidBytes(KID)) }] }] as any }]);
  assert.deepEqual(segs, [{ kid: KID, source: 'tenc', url: 'init.mp4' }]);

  const model = buildModel(events, [failed], segs, t + 60_000);
  const message = model.items.find((i) => i.name === 'message')!;
  assert.equal(message.keySystem, 'PlayReady');
  assert.equal(message.exchange?.matched, 'timing');
  assert.ok(message.issues.some((i) => i.startsWith('license request 500 Internal Server Error')));
  assert.ok(message.issues.some((i) => i.startsWith('no update() after this license-request')));
  const ks = model.items.find((i) => i.name === 'keystatuseschange')!;
  assert.deepEqual(ks.issues, [`key ${swapped}: output-restricted`]);
  // the swapped KID is folded onto the tenc KID, so no "missing key" issue
  assert.deepEqual(model.issues, []);
  assert.deepEqual(model.kids.find((k) => k.kid === KID)?.sources, ['tenc', 'keyStatus (GUID byte order)']);
});

test('real Widevine session (dash.js + Shaka proxy, Chrome): certificate + license round trips decode', async () => {
  const { readFileSync } = await import('node:fs');
  const { textToBytes, isLossyText } = await import('../src/eme/bytes');
  const events: RawEvent[] = JSON.parse(readFileSync(new URL('./fixtures/widevine-shaka-events.json', import.meta.url), 'utf8'));
  const messages = events.filter((e) => e.name === 'message');
  const challenge = Buffer.from((messages[1].value as { message: { $b64: string } }).message.$b64, 'base64');
  // DevTools hands a binary POST body over as one char per byte; the response (served as text/html) arrives lossy
  const harText = String.fromCharCode(...challenge);
  assert.ok(isLossyText('CAUS�'));
  const exchange: NetExchange = {
    url: 'https://cwip-shaka-proxy.appspot.com/no_auth',
    method: 'POST',
    status: 200,
    statusText: '',
    started: 1793724286755,
    duration: 220,
    requestHeaders: [],
    responseHeaders: [],
    requestBody: textToBytes(harText),
    responseLossy: true,
    mimeType: 'text/html',
  };
  const stale: NetExchange = { ...exchange, started: 1793724269859 }; // from the load before the hooked reload
  const m = buildModel(events, [stale, exchange], [], 0);
  const titles = m.items.flatMap((i) => i.payloads.map((p) => p.parsed.title));
  assert.deepEqual(titles, [
    'cenc init data · 1 pssh (Widevine)',
    'Widevine SERVICE_CERTIFICATE_REQUEST',
    'Widevine SERVICE_CERTIFICATE',
    'Widevine LICENSE_REQUEST · client ID encrypted (privacy mode)',
    'Widevine LICENSE · 5 content keys',
    'webm init data',
    'cenc init data · 1 pssh (Widevine)',
  ]);
  const license = m.items.find((i) => i.payloads[0]?.parsed.title.startsWith('Widevine LICENSE ·'))!;
  assert.equal(license.exchange?.matched, 'bytes');
  assert.equal(license.exchange?.started, exchange.started);
  // the 5 key-status KIDs are exactly the 5 content keys of the license
  const s = m.sessions[0];
  assert.equal(s.sessionId, '0A9A1132F423F22BF053CDF190FC7B85');
  assert.equal(s.keyStatuses.length, 5);
  assert.ok(s.keyStatuses.every((k) => k.status === 'usable' && m.kids.find((x) => x.kid === k.kid)?.sources.includes('license')));
  assert.ok(m.items[1].issues[0].startsWith('granted configuration has capabilities without a robustness level'));
  assert.deepEqual(m.issues, []);
});

test('exportLog keeps only matched license exchanges and redacts credential headers', async () => {
  const { exportLog, redactHeaders } = await import('../src/eme/model');
  const t = 2_000_000;
  const events: RawEvent[] = [
    { seq: 1, t, kind: 'call', name: 'createSession', target: 'MediaKeys#1', args: [] },
    { seq: 2, t: t + 1, kind: 'result', name: 'createSession', target: 'MediaKeys#1', callId: 1, value: { $ref: 'Session#1' } },
    { seq: 3, t: t + 10, kind: 'event', name: 'message', target: 'Session#1', value: { messageType: 'license-request', message: { $b64: 'CAQ=' } } },
    { seq: 4, t: t + 100, kind: 'call', name: 'update', target: 'Session#1', args: [{ $b64: 'CAU=' }] },
  ];
  const base = { method: 'POST', status: 200, statusText: 'OK', duration: 5, responseHeaders: [{ name: 'Set-Cookie', value: 's=1' }] };
  const license: NetExchange = { ...base, url: 'https://lic.example/wv', started: t + 20, requestHeaders: [{ name: 'Authorization', value: 'Bearer abc' }, { name: 'x-dt-custom-data', value: 'eyJ...' }, { name: 'content-type', value: 'application/octet-stream' }] };
  const login: NetExchange = { ...base, url: 'https://app.example/login', started: t - 1000, requestHeaders: [{ name: 'cookie', value: 'sid=secret' }], requestBody: new TextEncoder().encode('password=hunter2') };
  const out = exportLog(events, buildModel(events, [login, license], [])) as { exchanges: (NetExchange & { message: number })[] };
  assert.equal(out.exchanges.length, 1);
  const x = out.exchanges[0];
  assert.equal(x.url, license.url);
  assert.equal(x.message, 3);
  assert.deepEqual(x.requestHeaders, [
    { name: 'Authorization', value: '[redacted]' },
    { name: 'x-dt-custom-data', value: '[redacted]' },
    { name: 'content-type', value: 'application/octet-stream' },
  ]);
  assert.deepEqual(x.responseHeaders, [{ name: 'Set-Cookie', value: '[redacted]' }]);
  assert.ok(!JSON.stringify(out).includes('hunter2'));
  assert.deepEqual(redactHeaders([{ name: 'X-Api-Key', value: 'k' }]), [{ name: 'X-Api-Key', value: '[redacted]' }]);
});
