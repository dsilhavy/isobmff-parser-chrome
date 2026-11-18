import { hookSource } from './hook';
import type { RawEvent } from './types';

const POLL_MS = 500; // hook present, or expected after a reload
const IDLE_POLL_MS = 2000; // panel visible, page has no hook
const HIDDEN_POLL_MS = 5000; // panel hidden, hook present: keep draining so the page-side log does not overflow
const EXPECT_MS = 15_000;

/** Reloads the inspected page with the EME hook injected before any page script. */
export function armHook(): void {
  chrome.devtools.inspectedWindow.reload({ injectedScript: hookSource() });
}

/** Delay until the next poll, or `null` to stop (panel hidden and no hook on the page). */
export function pollDelay(visible: boolean, armed: boolean, expecting: boolean): number | null {
  if (!visible) return armed ? HIDDEN_POLL_MS : null;
  return armed || expecting ? POLL_MS : IDLE_POLL_MS;
}

export interface EmePoller {
  /** Panel shown / hidden. Showing polls at once. */
  setVisible(visible: boolean): void;
  /** A hooked page is about to load (after `armHook`): poll fast for a while. */
  expectHook(): void;
}

/**
 * Polls `window.__emeLog` of the top frame. `onBatch(events, reset)` gets new events;
 * `reset` is true when a new hooked page (another hook instance) replaced the old one.
 * `onArmed` reports whether the current page has the hook.
 */
// ponytail: top frame only; players in cross-origin iframes need a per-frame eval via `frameURL`
export function startEmePolling(onBatch: (events: RawEvent[], reset: boolean) => void, onArmed: (armed: boolean) => void): EmePoller {
  let instance: string | null = null;
  let lastSeq = 0;
  let armed: boolean | null = null;
  let busy = false;
  let visible = true;
  let expectUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    clearTimeout(timer);
    const delay = pollDelay(visible, armed === true, Date.now() < expectUntil);
    timer = delay === null ? undefined : setTimeout(tick, delay);
  };
  const handle = (result: { instance: string; events: RawEvent[] } | null, failed: boolean) => {
    const ok = !failed && !!result;
    if (ok !== armed) onArmed((armed = ok));
    if (!ok || !result) return;
    const reset = result.instance !== instance;
    if (reset) lastSeq = 0;
    instance = result.instance;
    const fresh = result.events.filter((e) => e.seq > lastSeq);
    if (fresh.length) lastSeq = fresh[fresh.length - 1].seq;
    if (fresh.length || reset) onBatch(fresh, reset);
  };
  const tick = () => {
    if (busy) return;
    busy = true;
    const expr = `(() => { const l = window.__emeLog; if (!l) return null; return { instance: l.instance, events: l.drain(l.instance === ${JSON.stringify(instance)} ? ${lastSeq} : 0) }; })()`;
    chrome.devtools.inspectedWindow.eval<{ instance: string; events: RawEvent[] } | null>(expr, (result, exc) => {
      busy = false;
      try {
        handle(result, !!exc);
      } finally {
        schedule();
      }
    });
  };
  tick();

  return {
    setVisible(v) {
      visible = v;
      if (v) {
        clearTimeout(timer);
        tick();
      } else schedule();
    },
    expectHook() {
      expectUntil = Date.now() + EXPECT_MS;
      schedule();
    },
  };
}
