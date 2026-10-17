import { platformReferences } from './platform-snapshot.ts';
import { historyReferences } from './platform-history.ts';

/** Public reference observations are display data, never executable market snapshots. */
export interface ReferenceObservation {
  slug: string;
  kind: 'YOUTUBE_VIEWS' | 'X_LIKES' | 'SPOTIFY_STREAMS';
  aggregation: 'cumulative' | 'daily';
  value: string;
  observedAtMs: number;
  capturedAtMs: number;
  reportedDate: string | null;
  provider: string;
  sourceUrl: string;
  rawSha256: string;
}

const bySlug = new Map(platformReferences.map(item => [item.slug, item]));
const historyBySlug = new Map(historyReferences.map(item => [item.slug, item]));
const count = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

export function validateReferenceObservation(value: unknown, nowMs = Date.now()): ReferenceObservation {
  if (!value || typeof value !== 'object') throw new Error('INVALID_REFERENCE_OBSERVATION');
  const item = value as Partial<ReferenceObservation>;
  const subject = typeof item.slug === 'string' ? bySlug.get(item.slug) : null;
  const history = typeof item.slug === 'string' ? historyBySlug.get(item.slug) : null;
  const expectedKind = subject?.metric.kind ?? (history?.platform === 'YouTube' ? 'YOUTUBE_VIEWS' : history?.platform === 'Spotify' ? 'SPOTIFY_STREAMS' : null);
  const expectedAggregation = history?.aggregation ?? 'cumulative';
  if (!expectedKind || item.kind !== expectedKind || item.aggregation !== expectedAggregation || !count(item.value) || !time(item.observedAtMs) ||
      !time(item.capturedAtMs) || item.observedAtMs > item.capturedAtMs || item.capturedAtMs > nowMs + 60_000 ||
      typeof item.provider !== 'string' || !item.provider.trim() || item.provider.length > 100 ||
      typeof item.sourceUrl !== 'string' || !/^https:\/\//.test(item.sourceUrl) ||
      !/^[a-f0-9]{64}$/.test(item.rawSha256 ?? '')) throw new Error('INVALID_REFERENCE_OBSERVATION');
  if (item.reportedDate !== null && (typeof item.reportedDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(item.reportedDate) ||
      Date.parse(`${item.reportedDate}T00:00:00Z`) !== item.observedAtMs)) throw new Error('INVALID_REFERENCE_OBSERVATION');
  if (item.reportedDate === null && item.observedAtMs !== item.capturedAtMs) throw new Error('INVALID_REFERENCE_OBSERVATION');
  const source = new URL(item.sourceUrl);
  if (!['https:'].includes(source.protocol) || source.username || source.password || source.hash) throw new Error('INVALID_REFERENCE_OBSERVATION');
  return {
    slug: item.slug!, kind: expectedKind, aggregation: expectedAggregation, value: item.value, observedAtMs: item.observedAtMs,
    capturedAtMs: item.capturedAtMs, reportedDate: item.reportedDate, provider: item.provider.trim(),
    sourceUrl: source.toString(), rawSha256: item.rawSha256!,
  };
}
