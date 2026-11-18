import { attr, childrenOf, type XmlDoc, type XmlElement } from './xml';

/** What the panel and later checks need at a glance. Attributes common to AdaptationSet and Representation are inherited. */
export interface RepresentationInfo {
  element: XmlElement;
  id?: string;
  bandwidth?: number;
  codecs?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  frameRate?: string;
  audioSamplingRate?: string;
}

export interface AdaptationSetInfo {
  element: XmlElement;
  id?: string;
  contentType?: string;
  mimeType?: string;
  lang?: string;
  codecs?: string;
  representations: RepresentationInfo[];
}

export interface PeriodInfo {
  element: XmlElement;
  id?: string;
  start?: number; // seconds
  duration?: number; // seconds
  adaptationSets: AdaptationSetInfo[];
}

export interface MpdSummary {
  type: 'static' | 'dynamic';
  profiles: string[];
  mediaPresentationDuration?: number;
  minBufferTime?: number;
  minimumUpdatePeriod?: number;
  timeShiftBufferDepth?: number;
  suggestedPresentationDelay?: number;
  availabilityStartTime?: string;
  publishTime?: string;
  periods: PeriodInfo[];
}

const DURATION = /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** `xs:duration` → seconds. Years and months use 365 and 30 days, as there is no anchor date. */
export function parseDuration(value: string | undefined): number | undefined {
  const m = value ? DURATION.exec(value.trim()) : null;
  if (!m || value!.trim().endsWith('T') || m.slice(2).every((p) => p === undefined)) return undefined;
  const [, sign, y, mo, d, h, mi, s] = m;
  const seconds = Number(y ?? 0) * 31_536_000 + Number(mo ?? 0) * 2_592_000 + Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0);
  return sign ? -seconds : seconds;
}

const int = (value: string | undefined): number | undefined => (value !== undefined && /^\d+$/.test(value.trim()) ? Number(value) : undefined);

function contentTypeOf(set: XmlElement, mimeType: string | undefined): string | undefined {
  const own = attr(set, 'contentType') ?? childrenOf(set, 'ContentComponent').map((c) => attr(c, 'contentType')).find(Boolean);
  if (own) return own;
  const mime = mimeType ?? childrenOf(set, 'Representation').map((r) => attr(r, 'mimeType')).find(Boolean);
  return mime?.split('/')[0];
}

export function summarize(doc: XmlDoc): MpdSummary | undefined {
  const mpd = doc.root;
  if (!mpd || mpd.local !== 'MPD') return undefined;
  const duration = (name: string) => parseDuration(attr(mpd, name));
  return {
    type: attr(mpd, 'type') === 'dynamic' ? 'dynamic' : 'static',
    profiles: (attr(mpd, 'profiles') ?? '').split(',').map((p) => p.trim()).filter(Boolean),
    mediaPresentationDuration: duration('mediaPresentationDuration'),
    minBufferTime: duration('minBufferTime'),
    minimumUpdatePeriod: duration('minimumUpdatePeriod'),
    timeShiftBufferDepth: duration('timeShiftBufferDepth'),
    suggestedPresentationDelay: duration('suggestedPresentationDelay'),
    availabilityStartTime: attr(mpd, 'availabilityStartTime'),
    publishTime: attr(mpd, 'publishTime'),
    periods: childrenOf(mpd, 'Period').map((period) => ({
      element: period,
      id: attr(period, 'id'),
      start: parseDuration(attr(period, 'start')),
      duration: parseDuration(attr(period, 'duration')),
      adaptationSets: childrenOf(period, 'AdaptationSet').map((set) => {
        const mimeType = attr(set, 'mimeType');
        const codecs = attr(set, 'codecs');
        return {
          element: set,
          id: attr(set, 'id'),
          contentType: contentTypeOf(set, mimeType),
          mimeType,
          lang: attr(set, 'lang'),
          codecs,
          representations: childrenOf(set, 'Representation').map((rep) => ({
            element: rep,
            id: attr(rep, 'id'),
            bandwidth: int(attr(rep, 'bandwidth')),
            codecs: attr(rep, 'codecs') ?? codecs,
            mimeType: attr(rep, 'mimeType') ?? mimeType,
            width: int(attr(rep, 'width') ?? attr(set, 'width')),
            height: int(attr(rep, 'height') ?? attr(set, 'height')),
            frameRate: attr(rep, 'frameRate') ?? attr(set, 'frameRate'),
            audioSamplingRate: attr(rep, 'audioSamplingRate') ?? attr(set, 'audioSamplingRate'),
          })),
        };
      }),
    })),
  };
}
