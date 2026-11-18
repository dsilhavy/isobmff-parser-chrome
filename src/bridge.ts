import { b64ToBytes, isLossyText, textToBytes } from './eme/bytes';
import { isIsoBmff } from './sniff';
import type { NetExchange } from './eme/types';

/**
 * Capture side of the extension. It runs in the DevTools page (`devtools.html`), which
 * Chrome loads as soon as DevTools opens, while the panel page is only loaded when its
 * tab is first selected. Requests seen before that are buffered here and handed over
 * once the panel connects; afterwards events are forwarded as they arrive.
 *
 * Everything that crosses to the panel is plain data (no Date, no parsed boxes): the two
 * pages are different realms, so the panel clones each event before using it.
 */

export const MAX_SEGMENTS = 200; // ponytail: fixed FIFO cap, make configurable if sessions need more
export const MAX_EXCHANGES = 100; // ponytail: FIFO of recent POSTs; only those matched to a license message are shown

export interface RawSegment {
  url: string;
  time: number; // epoch ms
  bytes: Uint8Array<ArrayBuffer>;
}

export type CaptureEvent =
  | { type: 'segment'; segment: RawSegment }
  | { type: 'exchange'; exchange: NetExchange }
  | { type: 'navigated'; url: string };

/** Implemented by the panel. */
export interface Sink {
  event(e: CaptureEvent): void;
  visible(v: boolean): void;
}

export interface Bridge {
  connect(sink: Sink): void;
  setVisible(v: boolean): void;
}

// Resource types DevTools reports that never carry a media segment.
const SKIP_TYPES = new Set(['image', 'font', 'stylesheet', 'script', 'document', 'websocket', 'manifest', 'ping', 'preflight', 'csp-violation-report', 'eventsource']);
// Textual and image/font MIME types. DevTools delivers textual bodies as text, which the sniffer cannot use anyway.
const SKIP_MIME = /^\s*(text\/|image\/|font\/|application\/(json|javascript|ecmascript|xml|[\w.-]+\+(json|xml))\s*(;|$))/i;

/** Cheap pre-check on request metadata, so the body is only fetched and decoded for plausible segments. */
export function isSegmentCandidate(meta: { resourceType?: string; mimeType?: string }): boolean {
  if (meta.resourceType && SKIP_TYPES.has(meta.resourceType)) return false;
  if (meta.mimeType && SKIP_MIME.test(meta.mimeType)) return false;
  return true;
}

export interface Queue extends Bridge {
  push(e: CaptureEvent): void;
}

/** Buffers events until a sink connects (FIFO, capped per kind), then forwards them directly. */
export function createQueue(limits: { segment: number; exchange: number } = { segment: MAX_SEGMENTS, exchange: MAX_EXCHANGES }): Queue {
  let pending: CaptureEvent[] = [];
  let sink: Sink | null = null;
  let visible = false;

  const deliver = (e: CaptureEvent) => {
    try {
      sink?.event(e);
    } catch {
      /* panel page is gone or failed on this event; keep capturing */
    }
  };
  const showTo = (s: Sink) => {
    try {
      s.visible(visible);
    } catch {
      /* see deliver */
    }
  };

  return {
    push(e) {
      if (sink) return deliver(e);
      if (e.type === 'navigated') {
        if (pending.at(-1)?.type === 'navigated') pending.pop(); // nothing was captured in between
        pending.push(e);
        return;
      }
      pending.push(e);
      if (pending.filter((x) => x.type === e.type).length > limits[e.type]) {
        pending.splice(pending.findIndex((x) => x.type === e.type), 1);
      }
    },
    connect(s) {
      sink = s;
      const buffered = pending;
      pending = [];
      buffered.forEach(deliver);
      showTo(s);
    },
    setVisible(v) {
      visible = v;
      if (sink) showTo(sink);
    },
  };
}

type HarRequest = chrome.devtools.network.Request;

function exchangeOf(request: HarRequest, content: string | undefined, encoding: string | undefined, decoded: Uint8Array | undefined): NetExchange {
  const responseLossy = !!content && encoding !== 'base64' && isLossyText(content);
  const responseBody = content && !responseLossy ? (encoding === 'base64' ? decoded : new TextEncoder().encode(content)) : undefined;
  const postText = request.request.postData?.text;
  return {
    url: request.request.url,
    method: request.request.method,
    status: request.response.status,
    statusText: request.response.statusText,
    started: Date.parse(request.startedDateTime),
    duration: request.time,
    requestHeaders: request.request.headers.map(({ name, value }) => ({ name, value })),
    responseHeaders: request.response.headers.map(({ name, value }) => ({ name, value })),
    requestBody: postText ? textToBytes(postText) : undefined,
    responseBody,
    responseLossy,
    mimeType: request.response.content.mimeType,
  };
}

/**
 * Registers the network listeners. Segment candidates are sniffed for ISOBMFF; every POST
 * is kept as a license / certificate candidate with its request and response bodies.
 */
export function startBridge(): Bridge {
  const queue = createQueue();

  chrome.devtools.network.onRequestFinished.addListener((request: HarRequest) => {
    const post = request.request.method === 'POST';
    const candidate = isSegmentCandidate({
      resourceType: (request as { _resourceType?: string })._resourceType,
      mimeType: request.response.content.mimeType,
    });
    if (!post && !candidate) return;

    request.getContent((content, encoding) => {
      let bytes: Uint8Array<ArrayBuffer> | undefined;
      if (content && encoding === 'base64') {
        try {
          bytes = b64ToBytes(content);
        } catch {
          bytes = undefined;
        }
      }
      if (post) queue.push({ type: 'exchange', exchange: exchangeOf(request, content, encoding, bytes) });
      if (candidate && bytes && isIsoBmff(bytes)) {
        queue.push({ type: 'segment', segment: { url: request.request.url, time: Date.now(), bytes } });
      }
    });
  });

  chrome.devtools.network.onNavigated.addListener((url) => queue.push({ type: 'navigated', url }));

  return queue;
}
