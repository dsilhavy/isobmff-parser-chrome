import { readIsoBoxes, type ParsedIsoBox } from '@svta/cml-iso-bmff';
import { readerConfig } from './readers';
import { isIsoBmff } from './sniff';

export interface Segment {
  url: string;
  time: Date;
  bytes: Uint8Array<ArrayBuffer>;
  boxes: ParsedIsoBox[];
  error?: string;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function startCapture(onSegment: (segment: Segment) => void): void {
  chrome.devtools.network.onRequestFinished.addListener((request) => {
    request.getContent((content, encoding) => {
      if (encoding !== 'base64' || !content) return;
      const bytes = base64ToBytes(content);
      if (!isIsoBmff(bytes)) return;
      const segment: Segment = {
        url: request.request.url,
        time: new Date(),
        bytes,
        boxes: [],
      };
      try {
        segment.boxes = readIsoBoxes(bytes, readerConfig);
      } catch (e) {
        segment.error = e instanceof Error ? e.message : String(e);
      }
      onSegment(segment);
    });
  });
}
