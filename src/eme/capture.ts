import { b64ToBytes, isLossyText, textToBytes } from './bytes';
import { hookSource } from './hook';
import type { NetExchange, RawEvent } from './types';

const POLL_MS = 500;
const MAX_EXCHANGES = 100; // ponytail: FIFO of recent POSTs; only those matched to a license message are shown

/** Reloads the inspected page with the EME hook injected before any page script. */
export function armHook(): void {
  chrome.devtools.inspectedWindow.reload({ injectedScript: hookSource() });
}

/**
 * Polls `window.__emeLog` of the top frame. `onBatch(events, reset)` gets new events;
 * `reset` is true when a new hooked page (another hook instance) replaced the old one.
 * `onArmed` reports whether the current page has the hook.
 */
// ponytail: top frame only; players in cross-origin iframes need a per-frame eval via `frameURL`
export function startEmePolling(onBatch: (events: RawEvent[], reset: boolean) => void, onArmed: (armed: boolean) => void): void {
  let instance: string | null = null;
  let lastSeq = 0;
  let armed: boolean | null = null;
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    const expr = `(() => { const l = window.__emeLog; if (!l) return null; return { instance: l.instance, events: l.drain(l.instance === ${JSON.stringify(instance)} ? ${lastSeq} : 0) }; })()`;
    chrome.devtools.inspectedWindow.eval<{ instance: string; events: RawEvent[] } | null>(expr, (result, exc) => {
      busy = false;
      const ok = !exc && !!result;
      if (ok !== armed) onArmed((armed = ok));
      if (!ok || !result) return;
      const reset = result.instance !== instance;
      if (reset) lastSeq = 0;
      instance = result.instance;
      const fresh = result.events.filter((e) => e.seq > lastSeq);
      if (fresh.length) lastSeq = fresh[fresh.length - 1].seq;
      if (fresh.length || reset) onBatch(fresh, reset);
    });
  };
  setInterval(tick, POLL_MS);
  tick();
}

type HarRequest = chrome.devtools.network.Request;

const bodyBytes = (text: string | undefined): Uint8Array | undefined => (text ? textToBytes(text) : undefined);

/** Collects POST requests (license / certificate candidates) with request and response bodies. */
export function startLicenseCapture(onExchange: (x: NetExchange) => void): void {
  chrome.devtools.network.onRequestFinished.addListener((request: HarRequest) => {
    if (request.request.method !== 'POST') return;
    request.getContent((content, encoding) => {
      let responseBody: Uint8Array | undefined;
      const responseLossy = !!content && encoding !== 'base64' && isLossyText(content);
      try {
        responseBody = content && !responseLossy ? (encoding === 'base64' ? b64ToBytes(content) : new TextEncoder().encode(content)) : undefined;
      } catch {
        responseBody = undefined;
      }
      onExchange({
        url: request.request.url,
        method: request.request.method,
        status: request.response.status,
        statusText: request.response.statusText,
        started: Date.parse(request.startedDateTime),
        duration: request.time,
        requestHeaders: request.request.headers,
        responseHeaders: request.response.headers,
        requestBody: bodyBytes(request.request.postData?.text),
        responseBody,
        responseLossy,
        mimeType: request.response.content.mimeType,
      });
    });
  });
}

export { MAX_EXCHANGES };
