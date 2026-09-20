import type { ParsedIsoBox } from '@svta/cml-iso-bmff';

/** Child boxes: `boxes` of containers, `entries` of stsd (sample entries). */
export const childrenOf = (box: ParsedIsoBox): ParsedIsoBox[] => {
  const b = box as { boxes?: ParsedIsoBox[]; entries?: unknown[] };
  return b.boxes ?? (box.type === 'stsd' ? (b.entries as ParsedIsoBox[]) : undefined) ?? [];
};

/** Depth-first search for the first box of `type`. */
export function findBox(boxes: ParsedIsoBox[], type: string): ParsedIsoBox | undefined {
  for (const b of boxes) {
    if (b.type === type) return b;
    const hit = findBox(childrenOf(b), type);
    if (hit) return hit;
  }
  return undefined;
}

/** Ancestors of `target`, root first; undefined if not in the tree. */
export function pathTo(boxes: ParsedIsoBox[], target: ParsedIsoBox, trail: ParsedIsoBox[] = []): ParsedIsoBox[] | undefined {
  for (const b of boxes) {
    if (b === target) return trail;
    const hit = pathTo(childrenOf(b), target, [...trail, b]);
    if (hit) return hit;
  }
  return undefined;
}
