import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformReferences } from '../../../contracts/reference/platform-snapshot.ts';
import { ReferenceObservationStore } from './reference-observations.ts';

const posts = platformReferences.filter(item => item.platform === 'X');
const postId = (url: string) => new URL(url).pathname.match(/\/status\/(\d+)$/)?.[1];

/** One bounded paid lookup for the exact approved public posts. No scheduler is installed here. */
export async function collectXReferenceLikes(input: {
  dbPath: string; bearerToken: string; fetcher?: typeof fetch; nowMs?: () => number;
}) {
  if (!input.bearerToken || input.bearerToken.length > 4096 || /[\r\n]/.test(input.bearerToken))
    throw new Error('X_BEARER_TOKEN_REQUIRED');
  const ids = posts.map(item => postId(item.subjectUrl));
  if (ids.length !== 3 || ids.some(id => !id)) throw new Error('X_POST_ALLOWLIST_INVALID');
  const url = new URL('https://api.x.com/2/tweets');
  url.searchParams.set('ids', ids.join(','));
  url.searchParams.set('tweet.fields', 'public_metrics');
  const response = await (input.fetcher ?? fetch)(url.toString(), {
    headers: { Authorization: `Bearer ${input.bearerToken}` }, cache: 'no-store',
  });
  if (!response.ok) throw new Error(`X_PROVIDER_HTTP_${response.status}`);
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.byteLength > 2_000_000) throw new Error('X_RESPONSE_TOO_LARGE');
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new Error('X_RESPONSE_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || !('data' in parsed) || !Array.isArray(parsed.data))
    throw new Error('X_RESPONSE_INVALID');
  const byId = new Map<string, string>();
  for (const item of parsed.data) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !ids.includes(item.id) ||
        byId.has(item.id) || !item.public_metrics ||
        !Number.isSafeInteger(item.public_metrics.like_count) || item.public_metrics.like_count < 0)
      throw new Error('X_RESPONSE_INVALID');
    byId.set(item.id, String(item.public_metrics.like_count));
  }
  const capturedAtMs = (input.nowMs ?? Date.now)();
  const rawSha256 = createHash('sha256').update(raw).digest('hex');
  const store = new ReferenceObservationStore(resolve(input.dbPath));
  const inserted: string[] = [], missing: string[] = [];
  try {
    for (const subject of posts) {
      const value = byId.get(postId(subject.subjectUrl)!);
      if (value === undefined) { missing.push(subject.slug); continue; }
      const added = store.append({ slug: subject.slug, kind: 'X_LIKES', aggregation: 'cumulative',
        value, observedAtMs: capturedAtMs, capturedAtMs, reportedDate: null, provider: 'X API',
        sourceUrl: subject.subjectUrl, rawSha256 }, raw, capturedAtMs);
      if (added) inserted.push(subject.slug);
    }
  } finally { store.close(); }
  return { inserted, missing, capturedAtMs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbPath = process.argv[2];
  const keyPath = process.env.ANTE_UP_X_BEARER_TOKEN_FILE;
  if (!dbPath || !keyPath || process.env.ANTE_UP_X_POST_LOOKUP_ALLOW_PAID !== '1')
    throw new Error('Usage: ANTE_UP_X_BEARER_TOKEN_FILE=<secret-file> ANTE_UP_X_POST_LOOKUP_ALLOW_PAID=1 node reference-x-posts.ts <persistent-api-db.sqlite>');
  const bearerToken = (await readFile(resolve(keyPath), 'utf8')).trim();
  console.log(JSON.stringify(await collectXReferenceLikes({ dbPath, bearerToken })));
}
