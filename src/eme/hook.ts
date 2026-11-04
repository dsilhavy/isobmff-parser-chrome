/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Runs in the inspected page's main world, before page scripts, via
 * `chrome.devtools.inspectedWindow.reload({ injectedScript })`. It is serialised
 * with Function#toString, so it must not reference anything outside its own body
 * (no imports, no module-level helpers).
 *
 * Wraps the EME API and records calls, results and events into `window.__emeLog`,
 * which the panel drains by polling. Binary data is copied to base64 at call time
 * because players reuse their buffers.
 */
export function installEmeHook(): void {
  const w = globalThis as any;
  if (w.__emeLog) return;
  const MAX = 2000;
  const log: any[] = [];
  let seq = 0;
  const ids = new WeakMap<object, string>();
  const counts: Record<string, number> = {};
  const watched = new WeakSet<object>();
  const seenEvents = new WeakSet<object>();
  const ET = w.EventTarget?.prototype;
  const origAdd: ((this: any, ...a: any[]) => void) | undefined = ET?.addEventListener;
  const listen = (t: any, type: string, f: (e: any) => void, capture = false) => (origAdd ? origAdd.call(t, type, f, capture) : t.addEventListener?.(type, f, capture));

  const idOf = (o: object, prefix: string): string => {
    let id = ids.get(o);
    if (!id) {
      counts[prefix] = (counts[prefix] ?? 0) + 1;
      id = `${prefix}#${counts[prefix]}`;
      ids.set(o, id);
    }
    return id;
  };
  const is = (o: any, ctor: string) => typeof w[ctor] === 'function' && o instanceof w[ctor];
  const prefixOf = (o: any): string | undefined =>
    is(o, 'MediaKeySession') ? 'Session' : is(o, 'MediaKeys') ? 'MediaKeys' : is(o, 'MediaKeySystemAccess') ? 'Access' : is(o, 'HTMLMediaElement') ? 'Media' : undefined;

  const toB64 = (v: ArrayBuffer | ArrayBufferView): string => {
    const u8 = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
    return btoa(s);
  };
  const ser = (v: any, depth = 0): any => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'function') return '[function]';
    if (typeof v !== 'object') return typeof v === 'number' && !Number.isFinite(v) ? String(v) : v;
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { $b64: toB64(v) };
    const p = prefixOf(v);
    if (p) return { $ref: idOf(v, p) };
    if (depth > 5) return '…';
    if (Array.isArray(v)) return v.map((x) => ser(x, depth + 1));
    const out: Record<string, any> = {};
    for (const k in v) {
      try {
        out[k] = ser(v[k], depth + 1);
      } catch {
        /* getter threw */
      }
    }
    return out;
  };
  const now = () => (typeof performance !== 'undefined' && performance.timeOrigin ? performance.timeOrigin + performance.now() : Date.now());
  const push = (e: any) => {
    e.seq = ++seq;
    e.t = now();
    log.push(e);
    if (log.length > MAX) log.splice(0, log.length - MAX);
    return e;
  };

  const wrap = (proto: any, name: string, prefix: string | null, onResult?: (value: any, self: any) => any) => {
    const orig = proto?.[name];
    if (typeof orig !== 'function' || orig.__emeWrapped) return;
    const wrapped = function (this: any, ...args: any[]) {
      const target = prefix && this && typeof this === 'object' ? idOf(this, prefix) : undefined;
      const call = push({ kind: 'call', name, target, args: args.map((a) => ser(a)) });
      const fail = (e: any) => push({ kind: 'error', name, target, callId: call.seq, error: { name: e?.name ?? 'Error', message: e?.message ?? String(e) } });
      const ok = (v: any) => {
        try {
          push({ kind: 'result', name, target, callId: call.seq, value: onResult ? onResult(v, this) : ser(v) });
        } catch {
          push({ kind: 'result', name, target, callId: call.seq });
        }
      };
      let r: any;
      try {
        r = orig.apply(this, args);
      } catch (e) {
        fail(e);
        throw e;
      }
      if (r && typeof r.then === 'function') r.then(ok, fail);
      else ok(r);
      return r;
    };
    (wrapped as any).__emeWrapped = true;
    try {
      Object.defineProperty(proto, name, { value: wrapped, writable: true, configurable: true });
    } catch {
      proto[name] = wrapped;
    }
  };

  const watchSession = (s: any) => {
    if (!s || watched.has(s)) return;
    watched.add(s);
    const target = idOf(s, 'Session');
    listen(s, 'message', (e) => push({ kind: 'event', name: 'message', target, value: { messageType: e.messageType, message: ser(e.message), sessionId: s.sessionId } }));
    listen(s, 'keystatuseschange', () => {
      const keyStatuses: any[] = [];
      try {
        s.keyStatuses.forEach((a: any, b: any) => {
          // spec: (status, keyId); some old builds passed (keyId, status)
          const [status, kid] = typeof a === 'string' ? [a, b] : [b, a];
          keyStatuses.push({ kid: ser(kid), status });
        });
      } catch {
        /* no keyStatuses */
      }
      push({ kind: 'event', name: 'keystatuseschange', target, value: { keyStatuses, expiration: ser(s.expiration), sessionId: s.sessionId } });
    });
    s.closed?.then?.(
      (reason: any) => push({ kind: 'event', name: 'closed', target, value: { reason: reason ?? null, sessionId: s.sessionId } }),
      () => undefined,
    );
  };

  const onMediaEvent = (e: any) => {
    if (seenEvents.has(e)) return;
    seenEvents.add(e);
    const target = e.target && typeof e.target === 'object' ? idOf(e.target, 'Media') : undefined;
    if (e.type === 'encrypted') push({ kind: 'event', name: 'encrypted', target, value: { initDataType: e.initDataType, initData: ser(e.initData) } });
    else push({ kind: 'event', name: e.type, target });
  };
  const watchMedia = (m: any) => {
    if (watched.has(m)) return;
    watched.add(m);
    listen(m, 'encrypted', onMediaEvent);
    listen(m, 'waitingforkey', onMediaEvent);
  };

  // ---- API surface ----
  const nav = w.Navigator?.prototype && 'requestMediaKeySystemAccess' in w.Navigator.prototype ? w.Navigator.prototype : w.navigator;
  wrap(nav, 'requestMediaKeySystemAccess', null, (access) => {
    let configuration: any;
    try {
      configuration = ser(access.getConfiguration());
    } catch {
      /* not available */
    }
    return { ...ser(access), keySystem: access?.keySystem, configuration };
  });
  wrap(w.MediaKeySystemAccess?.prototype, 'createMediaKeys', 'Access');
  wrap(w.MediaKeys?.prototype, 'createSession', 'MediaKeys', (s) => {
    watchSession(s);
    return ser(s);
  });
  wrap(w.MediaKeys?.prototype, 'setServerCertificate', 'MediaKeys');
  wrap(w.MediaKeys?.prototype, 'getStatusForPolicy', 'MediaKeys');
  const sessionResult = (v: any, self: any) => ({ value: ser(v), sessionId: self?.sessionId });
  for (const m of ['generateRequest', 'load', 'update', 'close', 'remove']) wrap(w.MediaKeySession?.prototype, m, 'Session', sessionResult);
  wrap(w.HTMLMediaElement?.prototype, 'setMediaKeys', 'Media', (v, self) => {
    watchMedia(self);
    return ser(v);
  });

  // encrypted / waitingforkey: capture on window for attached elements, plus direct listeners on any media element the page listens on
  if (origAdd && ET) {
    try {
      listen(w, 'encrypted', onMediaEvent, true);
      listen(w, 'waitingforkey', onMediaEvent, true);
    } catch {
      /* global is not an EventTarget (workers, tests) */
    }
    ET.addEventListener = function (this: any, type: any, ...rest: any[]) {
      if ((type === 'encrypted' || type === 'waitingforkey') && is(this, 'HTMLMediaElement')) watchMedia(this);
      return origAdd.call(this, type, ...rest);
    };
  }

  const instance = Math.random().toString(36).slice(2);
  push({ kind: 'event', name: 'hook installed', value: { url: w.location?.href, userAgent: w.navigator?.userAgent } });
  Object.defineProperty(w, '__emeLog', {
    value: { instance, drain: (after: number) => log.filter((e) => e.seq > after) },
    configurable: true,
  });
}

/**
 * Script text for `injectedScript`. The no-op `__name` covers transpilers that wrap
 * functions with a keepNames helper (esbuild/tsx), which would otherwise be undefined in the page.
 */
export const hookSource = (): string => `(() => { const __name = (f) => f; (${installEmeHook.toString()})(); })();`;
