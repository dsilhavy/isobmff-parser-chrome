import { summarize, type MpdSummary } from './model';
import { parseXml, type XmlDoc } from './xml';

export const MAX_SNAPSHOTS = 50; // refreshes kept per MPD

/** An MPD response as captured by the DevTools page (`src/bridge.ts`). */
export interface RawMpd {
  url: string;
  time: number; // epoch ms
  text: string;
  status?: number;
}

/** One distinct MPD body. Identical consecutive refreshes are folded into `count`. */
export interface Snapshot {
  id: number;
  time: number; // first seen, epoch ms
  lastTime: number; // last identical refresh
  count: number;
  status?: number;
  text: string;
  doc: XmlDoc;
  summary?: MpdSummary;
}

export interface MpdEntry {
  url: string;
  snapshots: Snapshot[]; // oldest first
  refreshes: number; // all responses seen, including identical and dropped ones
}

let nextId = 1;

/** Adds a response to its MPD (grouped by URL). Returns the snapshot and whether it is a new one. */
export function addMpd(entries: MpdEntry[], raw: RawMpd, max = MAX_SNAPSHOTS): { entry: MpdEntry; snapshot: Snapshot; added: boolean } {
  let entry = entries.find((e) => e.url === raw.url);
  if (!entry) entries.push((entry = { url: raw.url, snapshots: [], refreshes: 0 }));
  entry.refreshes++;
  const last = entry.snapshots.at(-1);
  if (last && last.text === raw.text) {
    last.count++;
    last.lastTime = raw.time;
    return { entry, snapshot: last, added: false };
  }
  const doc = parseXml(raw.text);
  const snapshot: Snapshot = { id: nextId++, time: raw.time, lastTime: raw.time, count: 1, status: raw.status, text: raw.text, doc, summary: summarize(doc) };
  entry.snapshots.push(snapshot);
  if (entry.snapshots.length > max) entry.snapshots.splice(0, entry.snapshots.length - max);
  return { entry, snapshot, added: true };
}
