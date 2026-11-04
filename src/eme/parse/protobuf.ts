import { hexUuid, printable, toHex, utf8, fourccOf } from '../bytes';
import type { PNode } from '../types';

export interface ProtoField {
  no: number;
  wire: 0 | 1 | 2 | 5;
  value: number | Uint8Array;
}

/** Wire-level protobuf decode. Undefined when the bytes are not a well-formed message. */
export function decodeProto(data: Uint8Array): ProtoField[] | undefined {
  const out: ProtoField[] = [];
  let pos = 0;
  const varint = (): number | undefined => {
    let v = 0;
    let shift = 0;
    while (pos < data.length) {
      const b = data[pos++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) return v;
      if (shift > 63) return undefined;
    }
    return undefined;
  };
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (pos < data.length) {
    const tag = varint();
    if (tag === undefined) return undefined;
    const no = Math.floor(tag / 8);
    const wire = tag % 8;
    if (no < 1) return undefined;
    if (wire === 0) {
      const v = varint();
      if (v === undefined) return undefined;
      out.push({ no, wire, value: v });
    } else if (wire === 2) {
      const len = varint();
      if (len === undefined || pos + len > data.length) return undefined;
      out.push({ no, wire, value: data.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === 1) {
      if (pos + 8 > data.length) return undefined;
      out.push({ no, wire, value: dv.getUint32(pos, true) + dv.getUint32(pos + 4, true) * 2 ** 32 });
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > data.length) return undefined;
      out.push({ no, wire, value: dv.getUint32(pos, true) });
      pos += 4;
    } else return undefined;
  }
  return out;
}

export type FieldKind = 'uint' | 'bool' | 'string' | 'bytes' | 'hex' | 'kid' | 'enum' | 'time' | 'duration' | 'fourcc' | 'size';

export interface FieldSpec {
  name: string;
  kind?: FieldKind; // default: uint for varints, bytes for length-delimited
  values?: Record<number, string>; // enum names
  msg?: () => Schema; // nested message
  parse?: (b: Uint8Array) => PNode[] | undefined; // custom decoder for a bytes field
  summary?: (children: PNode[]) => string | undefined; // one-line value for a nested message
}
export type Schema = Record<number, FieldSpec>;

const BYTES_PREVIEW = 48;

/** Bytes as text when printable, else hex (long values truncated with their size). */
export function bytesValue(b: Uint8Array): string {
  if (printable(b)) return JSON.stringify(utf8(b));
  if (b.length <= BYTES_PREVIEW) return toHex(b);
  return `${toHex(b.subarray(0, BYTES_PREVIEW))}… (${b.length.toLocaleString()} B)`;
}

const human = (s: number): string => {
  if (s < 60) return `${s} s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${s} s (${d ? `${d}d ` : ''}${h}h ${m}m)`;
};

function scalar(spec: FieldSpec | undefined, f: ProtoField): PNode {
  const label = spec?.name ?? `#${f.no}`;
  const v = f.value;
  if (typeof v === 'number') {
    switch (spec?.kind) {
      case 'bool':
        return { label, value: v ? 'true' : 'false' };
      case 'enum':
        return { label, value: `${spec.values?.[v] ?? 'unknown'} (${v})` };
      case 'time':
        return { label, value: v ? `${new Date(v * 1000).toISOString()} (${v})` : '0' };
      case 'duration':
        return { label, value: v ? human(v) : '0 (unlimited)' };
      case 'fourcc':
        return { label, value: `${fourccOf(v)} (0x${v.toString(16)})` };
      default:
        return { label, value: String(v) };
    }
  }
  switch (spec?.kind) {
    case 'string':
      return { label, value: JSON.stringify(utf8(v)) };
    case 'hex':
      return { label, value: toHex(v) };
    case 'size':
      return { label, value: `${v.length.toLocaleString()} B` };
    case 'kid':
      return v.length === 16 ? { label, value: hexUuid(v), kid: hexUuid(v) } : { label, value: bytesValue(v) };
    default:
      return { label, value: bytesValue(v) };
  }
}

/** Schema-driven decode to display nodes; unknown fields are kept as `#n`. Undefined if not a protobuf. */
export function decodeWith(bytes: Uint8Array, schema: Schema): PNode[] | undefined {
  const fields = decodeProto(bytes);
  if (!fields) return undefined;
  const nodes: PNode[] = [];
  for (const f of fields) {
    const spec = schema[f.no];
    if (f.value instanceof Uint8Array && (spec?.msg || spec?.parse)) {
      const children = spec.msg ? decodeWith(f.value, spec.msg()) : spec.parse!(f.value);
      if (children) {
        nodes.push({ label: spec.name, value: spec.summary?.(children), children });
        continue;
      }
    }
    nodes.push(scalar(spec, f));
  }
  // number repeated siblings: key[0], key[1], …
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.label, (counts.get(n.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const n of nodes) {
    if (counts.get(n.label)! < 2) continue;
    const i = seen.get(n.label) ?? 0;
    seen.set(n.label, i + 1);
    n.label = `${n.label}[${i}]`;
  }
  return nodes;
}

/** Value of the first child whose label (without [i]) is `label`. */
export const childValue = (nodes: PNode[], label: string): string | undefined => nodes.find((n) => n.label.replace(/\[\d+\]$/, '') === label)?.value;
