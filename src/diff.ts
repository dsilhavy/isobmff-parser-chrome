import type { ParsedIsoBox } from '@svta/cml-iso-bmff';
import { childrenOf } from './boxes';
import { formatValue } from './format';

const SKIP = new Set(['type', 'size', 'view', 'boxes', 'largesize', 'usertype', 'entries']);

/** Leaf fields of a box tree keyed by path, e.g. `moov/trak[1]/mdia/mdhd.timescale`; first sibling of a type has no index. */
export function flatten(boxes: ParsedIsoBox[], prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const box of boxes) {
    const n = seen.get(box.type) ?? 0;
    seen.set(box.type, n + 1);
    const path = `${prefix}${box.type}${n ? `[${n}]` : ''}`;
    for (const [k, v] of Object.entries(box)) {
      if (SKIP.has(k) || v === undefined || (k === 'entries' && box.type === 'stsd')) continue;
      out.set(`${path}.${k}`, formatValue(v));
    }
    for (const [k, v] of flatten(childrenOf(box), `${path}/`)) out.set(k, v);
  }
  return out;
}

export interface Change {
  path: string;
  a?: string;
  b?: string;
}

/** Leaves that differ between two box trees, in `a` path order with additions from `b` appended. */
export function diff(a: ParsedIsoBox[], b: ParsedIsoBox[]): Change[] {
  const fa = flatten(a);
  const fb = flatten(b);
  const out: Change[] = [];
  for (const [path, va] of fa) if (fb.get(path) !== va) out.push({ path, a: va, b: fb.get(path) });
  for (const [path, vb] of fb) if (!fa.has(path)) out.push({ path, b: vb });
  return out;
}
