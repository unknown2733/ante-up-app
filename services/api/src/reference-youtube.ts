import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { platformReferences } from '../../../contracts/reference/platform-snapshot.ts';
import { ReferenceObservationStore } from './reference-observations.ts';

const videos = platformReferences.filter(item => item.platform === 'YouTube');

/** One bounded YouTube statistics batch for the exact approved reference videos. */
export async function collectYouTubeReferenceViews(input: {
  dbPath: string; apiKey: string; fetcher?: typeof fetch; nowMs?: () => number;
}) {
  if (!input.apiKey || input.apiKey.length > 512) throw new Error('YOUTUBE_KEY_REQUIRED');
  const url = new URL('https://www.googleapis.com/youtube/v3/videos:batchGetStats');
  url.searchParams.set('part', 'statistics');
  url.searchParams.set('id', videos.map(item => new URL(item.subjectUrl).searchParams.get('v')).join(','));
  const response = await (input.fetcher ?? fetch)(url.toString(), {
    cache: 'no-store', headers: { 'x-goog-api-key': input.apiKey },
  });
  if (!response.ok) throw new Error(`YOUTUBE_PROVIDER_HTTP_${response.status}`);
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.byteLength > 2_000_000) throw new Error('YOUTUBE_RESPONSE_TOO_LARGE');
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new Error('YOUTUBE_RESPONSE_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || !('items' in parsed) || !Array.isArray(parsed.items))
    throw new Error('YOUTUBE_RESPONSE_INVALID');
  const capturedAtMs = (input.nowMs ?? Date.now)();
  const rawSha256 = createHash('sha256').update(raw).digest('hex');
  const byId = new Map<string, string>();
  for (const item of parsed.items) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' ||
        !item.statistics || typeof item.statistics.viewCount !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(item.statistics.viewCount) || byId.has(item.id))
      throw new Error('YOUTUBE_RESPONSE_INVALID');
    byId.set(item.id, item.statistics.viewCount);
  }
  const store = new ReferenceObservationStore(resolve(input.dbPath));
  const inserted: string[] = [], missing: string[] = [];
  try {
    for (const subject of videos) {
      const id = new URL(subject.subjectUrl).searchParams.get('v')!;
      const value = byId.get(id);
      if (!value) { missing.push(subject.slug); continue; }
      const added = store.append({ slug: subject.slug, kind: 'YOUTUBE_VIEWS', aggregation: 'cumulative',
        value, observedAtMs: capturedAtMs, capturedAtMs, reportedDate: null, provider: 'YouTube Data API',
        sourceUrl: subject.subjectUrl, rawSha256 }, raw, capturedAtMs);
      if (added) inserted.push(subject.slug);
    }
  } finally { store.close(); }
  return { inserted, missing, capturedAtMs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbPath = process.argv[2];
  const keyPath = process.env.ANTE_UP_YOUTUBE_API_KEY_FILE;
  if (!dbPath || !keyPath) throw new Error('Usage: ANTE_UP_YOUTUBE_API_KEY_FILE=<secret-file> node reference-youtube.ts <persistent-api-db.sqlite>');
  const apiKey = (await readFile(resolve(keyPath), 'utf8')).trim();
  console.log(JSON.stringify(await collectYouTubeReferenceViews({ dbPath, apiKey })));
}
