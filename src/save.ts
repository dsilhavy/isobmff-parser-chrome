import type { Segment } from './capture';

/** One file inside the archive / target folder: `<host>/<name>`. */
export interface Entry {
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || 'unknown-host';
  } catch {
    return 'unknown-host';
  }
}

/**
 * The capture index prefix keeps arrival order visible and makes repeatedly
 * requested URLs (init segments, retries) collision-free without dedupe logic.
 */
function nameOf(url: string, index: number): string {
  const base = url.split('?')[0].split('#')[0].split('/').pop() || 'segment';
  return `${String(index + 1).padStart(4, '0')}-${base.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export function entriesFor(segments: Segment[]): Entry[] {
  return segments.map((segment, i) => ({
    path: `${hostOf(segment.url)}/${nameOf(segment.url, i)}`,
    bytes: segment.bytes,
  }));
}

function dosDateTime(d: Date): [time: number, date: number] {
  return [
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  ];
}

/**
 * Store-only (uncompressed) zip — media segments are already compressed, so
 * deflate would only cost CPU.
 * ponytail: no ZIP64, so a total archive above 4 GiB would need the 64-bit
 * headers added; the panel's 200-segment cap keeps that out of reach in practice.
 */
export function buildZip(entries: Entry[]): Blob {
  const encoder = new TextEncoder();
  const [time, date] = dosDateTime(new Date());
  const local: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const size = entry.bytes.byteLength;
    const crc = crc32(entry.bytes);

    const header = new Uint8Array(30 + name.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true); // version needed
    h.setUint16(6, 0x0800, true); // UTF-8 names
    h.setUint16(8, 0, true); // stored
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, size, true);
    h.setUint32(22, size, true);
    h.setUint16(26, name.length, true);
    header.set(name, 30);
    local.push(header, entry.bytes);

    const record = new Uint8Array(46 + name.length);
    const r = new DataView(record.buffer);
    r.setUint32(0, 0x02014b50, true);
    r.setUint16(4, 20, true); // version made by
    r.setUint16(6, 20, true); // version needed
    r.setUint16(8, 0x0800, true);
    r.setUint16(10, 0, true);
    r.setUint16(12, time, true);
    r.setUint16(14, date, true);
    r.setUint32(16, crc, true);
    r.setUint32(20, size, true);
    r.setUint32(24, size, true);
    r.setUint16(28, name.length, true);
    r.setUint32(42, offset, true); // offset of the local header
    record.set(name, 46);
    central.push(record);

    offset += header.length + size;
    centralSize += record.length;
  }

  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);

  return new Blob([...local, ...central, end], { type: 'application/zip' });
}

function downloadZip(entries: Entry[]): void {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const url = URL.createObjectURL(buildZip(entries));
  const a = document.createElement('a');
  a.href = url;
  a.download = `isobmff-segments-${stamp}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

type Picker = (options?: object) => Promise<FileSystemDirectoryHandle>;

async function writeToFolder(root: FileSystemDirectoryHandle, entries: Entry[]): Promise<void> {
  for (const entry of entries) {
    const slash = entry.path.indexOf('/');
    const dir = await root.getDirectoryHandle(entry.path.slice(0, slash), { create: true });
    const file = await dir.getFileHandle(entry.path.slice(slash + 1), { create: true });
    const writable = await file.createWritable();
    await writable.write(entry.bytes);
    await writable.close();
  }
}

/**
 * Saves every captured segment as `<host>/<index>-<filename>`, into a folder the
 * user picks. Falls back to a single zip download when the directory picker is
 * unavailable or blocked (the DevTools panel is an iframe, so it can be).
 * Returns a status message; rejects only if saving itself failed.
 */
export async function saveAll(segments: Segment[]): Promise<string> {
  if (!segments.length) return 'nothing to save';
  const entries = entriesFor(segments);
  const picker = (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker;

  if (picker) {
    let root: FileSystemDirectoryHandle | null = null;
    try {
      root = await picker.call(window, { id: 'isobmff-segments', mode: 'readwrite' });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'save cancelled';
      root = null; // blocked in this context — fall through to the zip
    }
    if (root) {
      await writeToFolder(root, entries);
      return `saved ${entries.length} segments to ${root.name}/`;
    }
  }

  downloadZip(entries);
  return `saved ${entries.length} segments as a zip`;
}
