import type { Segment } from './capture';
import type { Lane } from './continuity';
import type { MpdEntry } from './mpd/store';

/**
 * One model for everything the tool reports: MPD problems, segment problems and (later)
 * cross-checks and session observations, so they share one list, filter and export.
 */

/** Spec language: "shall" → error, "should" → warning, observations → info. */
export type Severity = 'error' | 'warning' | 'info';
/** `conformance`: is the content valid? `session`: what happened in this playback? */
export type Lens = 'conformance' | 'session';

/** What a check reports, before it is tied to a place. */
export interface Issue {
  id: string; // stable rule identifier, e.g. 'dash.init-ftyp'
  severity: Severity;
  message: string; // the rule, worded so that equal problems group together
  clause?: string; // e.g. 'ISO/IEC 23009-1 6.3.4'
  detail?: string; // what is specific to this occurrence
  summary?: string; // one-line form for tooltips, when the message alone says too little
  requirement?: string; // what the clause asks for, in our words
  box?: string; // segment findings: box type to open
}

export type Location =
  | { kind: 'segment'; segment: Segment; box?: string }
  | { kind: 'mpd'; url: string; snapshotId: number; line?: number };

export interface Finding extends Issue {
  lens: Lens;
  source: 'mpd' | 'segment';
  where: string; // short label of the location
  time: number; // capture time, epoch ms
  location: Location;
}

export interface FindingGroup {
  key: string;
  id: string;
  severity: Severity;
  lens: Lens;
  source: 'mpd' | 'segment';
  message: string;
  clause?: string;
  requirement?: string;
  findings: Finding[];
}

export const DASH = 'ISO/IEC 23009-1';

/** The one-line form used in the segment list tooltip and by the `dash` filter keyword. */
export const issueText = (i: Issue): string => `${i.clause?.startsWith(DASH) ? `DASH ${i.clause.slice(DASH.length + 1)}: ` : ''}${i.summary ?? i.message}`;

const basename = (url: string) => url.split(/[?#]/)[0].split('/').pop() || url;
const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** All findings of the current capture. `segmentIssues` is injected to keep this module free of the box parsers. */
export function collectFindings(segments: Segment[], lanes: Lane[], mpds: MpdEntry[], segmentIssues: (s: Segment) => Issue[]): Finding[] {
  const out: Finding[] = [];
  for (const entry of mpds) {
    for (const snapshot of entry.snapshots) {
      for (const e of snapshot.doc.errors) {
        out.push({
          id: 'mpd.well-formed',
          severity: 'error',
          lens: 'conformance',
          source: 'mpd',
          message: 'MPD is not well-formed XML',
          detail: `line ${e.line}: ${e.message}`,
          where: `${basename(entry.url)} · version ${snapshot.id}`,
          time: snapshot.time,
          location: { kind: 'mpd', url: entry.url, snapshotId: snapshot.id, line: e.line },
        });
      }
    }
  }
  for (const segment of segments) {
    for (const issue of segmentIssues(segment)) {
      out.push({ ...issue, lens: 'conformance', source: 'segment', where: basename(segment.url), time: segment.time.getTime(), location: { kind: 'segment', segment, box: issue.box } });
    }
  }
  for (const lane of lanes) {
    for (const span of lane.spans) {
      const d = span.deltaBefore;
      if (!d || !segments.includes(span.segment)) continue;
      const size = lane.timescale ? `${+(Math.abs(d) / lane.timescale).toFixed(3)} s` : `${Math.abs(d)} ticks`;
      out.push({
        id: d > 0 ? 'timeline.gap' : 'timeline.overlap',
        severity: 'warning',
        lens: 'conformance',
        source: 'segment',
        message: d > 0 ? 'Gap between consecutive segments of a track' : 'Overlap between consecutive segments of a track',
        detail: `track ${lane.trackId} · ${size} before this segment`,
        box: 'tfdt',
        where: basename(span.segment.url),
        time: span.segment.time.getTime(),
        location: { kind: 'segment', segment: span.segment, box: 'tfdt' },
      });
    }
  }
  return out;
}

/** Equal problems (same rule and wording) as one group; errors first, then by first occurrence. */
export function groupFindings(findings: Finding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const f of findings) {
    const key = f.id; // one rule, one group; what differs per occurrence is in `detail`
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, id: f.id, severity: f.severity, lens: f.lens, source: f.source, message: f.message, clause: f.clause, requirement: f.requirement, findings: [] }));
    g.findings.push(f);
  }
  return [...groups.values()].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** Case-insensitive; whitespace-separated terms must all match severity, lens, source, clause, rule id or message. */
export function matchesGroup(group: FindingGroup, query: string): boolean {
  const hay = `${group.severity} ${group.lens} ${group.source} ${group.clause ?? ''} ${group.id} ${group.message}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => hay.includes(term));
}

export function severityCounts(groups: FindingGroup[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const g of groups) counts[g.severity]++;
  return counts;
}
