import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { platformReferences } from '../../../contracts/reference/platform-snapshot.ts';
import { parseKworbReport } from '../../../scripts/backfill-kworb-reference.mjs';
import { ReferenceObservationStore } from './reference-observations.ts';

const tracks = platformReferences.filter(item => item.platform === 'Spotify');

/** Daily third-party reference capture. Never used as an executable market oracle. */
export async function collectKworbReferenceStreams(input: {
  dbPath: string; fetcher?: typeof fetch; nowMs?: () => number;
}) {
  const capturedAtMs = (input.nowMs ?? Date.now)();
  const observations: Array<{
    slug: string; value: string; reportedDate: string; observedAtMs: number;
    provider: string; sourceUrl: string; rawSha256: string; raw: Buffer;
  }> = [];
  for (const subject of tracks) {
    const sourceUrl = subject.metric.sourceUrl;
    const trackId = new URL(subject.subjectUrl).pathname.split('/').at(-1)!;
    const response = await (input.fetcher ?? fetch)(sourceUrl, {
      cache: 'no-store', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`KWORB_PROVIDER_HTTP_${response.status}`);
    const raw = Buffer.from(await response.arrayBuffer());
    if (!raw.length || raw.length > 2_000_000) throw new Error('KWORB_RESPONSE_SIZE_INVALID');
    const { reportedDate, value } = parseKworbReport(raw.toString('utf8'), trackId);
    const observedAtMs = Date.parse(`${reportedDate}T00:00:00Z`);
    if (observedAtMs > capturedAtMs) throw new Error('KWORB_REPORT_IN_FUTURE');
    observations.push({ slug: subject.slug, value, reportedDate, observedAtMs,
      provider: 'Kworb', sourceUrl, rawSha256: createHash('sha256').update(raw).digest('hex'), raw });
  }
  const store = new ReferenceObservationStore(resolve(input.dbPath));
  const inserted: string[] = [], unchanged: string[] = [], stale: string[] = [];
  try {
    const latest = new Map(store.latest().map(item => [item.slug, item]));
    const toAppend: typeof observations = [];
    for (const item of observations) {
      const previous = latest.get(item.slug);
      if (previous && item.observedAtMs < previous.observedAtMs) {
        stale.push(item.slug); continue;
      }
      if (previous && item.observedAtMs === previous.observedAtMs && item.value === previous.value) {
        unchanged.push(item.slug); continue;
      }
      if (previous && item.observedAtMs > previous.observedAtMs &&
          BigInt(item.value) < BigInt(previous.value))
        throw new Error('KWORB_STREAM_COUNT_DECREASED');
      toAppend.push(item);
    }
    for (const item of toAppend) {
      const added = store.append({ slug: item.slug, kind: 'SPOTIFY_STREAMS',
        aggregation: 'cumulative', value: item.value, observedAtMs: item.observedAtMs,
        capturedAtMs, reportedDate: item.reportedDate, provider: item.provider,
        sourceUrl: item.sourceUrl, rawSha256: item.rawSha256 }, item.raw, capturedAtMs);
      (added ? inserted : unchanged).push(item.slug);
    }
  } finally { store.close(); }
  return { inserted, unchanged, stale, capturedAtMs };
}
