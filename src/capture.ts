import { readIsoBoxes, type ParsedIsoBox } from '@svta/cml-iso-bmff';
import { readerConfig } from './readers';
import type { RawSegment } from './bridge';

export interface Segment {
  url: string;
  time: Date;
  bytes: Uint8Array<ArrayBuffer>;
  boxes: ParsedIsoBox[];
  error?: string;
}

/** Parses a segment captured by the DevTools page (`src/bridge.ts`). */
export function parseSegment(raw: RawSegment): Segment {
  const segment: Segment = { url: raw.url, time: new Date(raw.time), bytes: raw.bytes, boxes: [] };
  try {
    segment.boxes = readIsoBoxes(raw.bytes, readerConfig);
  } catch (e) {
    segment.error = e instanceof Error ? e.message : String(e);
  }
  return segment;
}
