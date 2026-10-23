import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformReferences } from '../contracts/reference/platform-snapshot.ts';

const subjects = platformReferences.filter(item => item.platform === 'Spotify');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Extract only the exact linked track row from a dated Kworb artist report. */
export function parseKworbReport(html, trackId) {
  const dateMatches = [...html.matchAll(/Last updated:\s*(\d{4})\/(\d{2})\/(\d{2})/g)];
  if (dateMatches.length !== 1) throw Error('KWORB_REPORT_DATE_AMBIGUOUS');
  const [, year, month, day] = dateMatches[0];
  const reportedDate = `${year}-${month}-${day}`;
  if (Number.isNaN(Date.parse(`${reportedDate}T00:00:00Z`))) throw Error('KWORB_REPORT_DATE_INVALID');
  const rows = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)]
    .filter(match => match[0].includes(`https://open.spotify.com/track/${trackId}`));
  if (rows.length !== 1) throw Error('KWORB_TRACK_ROW_AMBIGUOUS');
  const row = rows[0][0];
  const idMatches = [...row.matchAll(/https:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]+)/g)];
  if (idMatches.length !== 1 || idMatches[0][1] !== trackId) throw Error('KWORB_TRACK_ID_MISMATCH');
  const countMatch = row.match(/<\/a>[\s\S]*?<\/td>\s*<td>\s*([\d,]+)\s*<\/td>/i);
  if (!countMatch) throw Error('KWORB_STREAM_COUNT_MISSING');
  const value = countMatch[1].replaceAll(',', '');
  if (!/^[1-9]\d*$/.test(value)) throw Error('KWORB_STREAM_COUNT_INVALID');
  return { reportedDate, value };
}

export async function captureKworbReferences(outputDir, fetcher = fetch, now = Date.now) {
  const captures = [];
  for (const subject of subjects) {
    const sourceUrl = subject.metric.sourceUrl;
    const trackId = new URL(subject.subjectUrl).pathname.split('/').at(-1);
    const response = await fetcher(sourceUrl, { headers: { Accept: 'text/html' }, cache: 'no-store' });
    if (!response.ok) throw Error(`KWORB_PROVIDER_HTTP_${response.status}`);
    const raw = Buffer.from(await response.arrayBuffer());
    if (!raw.length || raw.length > 2_000_000) throw Error('KWORB_RESPONSE_SIZE_INVALID');
    const { reportedDate, value } = parseKworbReport(raw.toString('utf8'), trackId);
    const capturedAtMs = now();
    const observedAtMs = Date.parse(`${reportedDate}T00:00:00Z`);
    if (observedAtMs > capturedAtMs || reportedDate <= subject.metric.reportedDate ||
        BigInt(value) < BigInt(subject.metric.value)) throw Error('KWORB_REPORT_NOT_NEWER');
    captures.push({ slug: subject.slug, value, reportedDate, raw, observation: {
      slug: subject.slug, kind: 'SPOTIFY_STREAMS', aggregation: 'cumulative', value,
      observedAtMs, capturedAtMs, reportedDate, provider: 'Kworb', sourceUrl,
      rawSha256: sha256(raw),
    } });
  }
  await mkdir(outputDir, { recursive: true });
  for (const capture of captures) {
    await writeFile(resolve(outputDir, `${capture.slug}.html`), capture.raw);
    await writeFile(resolve(outputDir, `${capture.slug}.json`), JSON.stringify(capture.observation, null, 2) + '\n');
  }
  return captures.map(({ slug, value, reportedDate, observation }) => ({ slug, value, reportedDate, rawSha256: observation.rawSha256 }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Usage: node scripts/backfill-kworb-reference.mjs <output-directory>');
  console.log(JSON.stringify(await captureKworbReferences(resolve(process.argv[2]))));
}
