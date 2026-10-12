/** Free, public read-only sources. Run manually; no scheduled or paid provider calls. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { referenceSubjects } from '../contracts/reference/catalog.ts';

const root = new URL('../contracts/reference/', import.meta.url);
const DAY = 86_400_000;
const capturedAt = new Date().toISOString();
const latestRequested = new Date(Date.now() - DAY).toISOString().slice(0, 10);
const oldestRequested = new Date(Date.parse(`${latestRequested}T00:00:00Z`) - 44 * DAY).toISOString().slice(0, 10);
const stamp = date => date.replaceAll('-', '') + '00';
const hash = text => createHash('sha256').update(text).digest('hex');
const decode = text => text.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
const meta = (html, key) => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(match => [match[1].toLowerCase(), decode(match[3])]));
    if (attrs.property === key || attrs.name === key) return attrs.content;
  }
  return null;
};
async function get(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'AnteUpPublicReference/1.0 (https://github.com/unknown2733/ante-up-app)' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return { response, text: await response.text() };
}
await mkdir(new URL('raw/', root), { recursive: true });
const subjects = [];
for (const subject of referenceSubjects) {
  let imageUrl, sourceTitle, metadataUrl = subject.subjectUrl, metadataText;
  if (subject.githubLogin) {
    metadataUrl = `https://api.github.com/orgs/${subject.githubLogin}`;
    const result = await get(metadataUrl);
    metadataText = result.text;
    const org = JSON.parse(metadataText);
    if (org.login.toLowerCase() !== subject.githubLogin.toLowerCase() || org.html_url !== subject.subjectUrl) throw new Error(`GitHub identity mismatch: ${subject.slug}`);
    imageUrl = org.avatar_url;
    sourceTitle = org.name || org.login;
  } else {
    const result = await get(metadataUrl);
    metadataText = result.text;
    sourceTitle = meta(metadataText, 'og:title') ?? decode(metadataText.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    imageUrl = meta(metadataText, 'og:image');
    if (subject.youtubeId) {
      if (!metadataText.includes(subject.youtubeId)) throw new Error(`Official NASA page does not link video: ${subject.slug}`);
      imageUrl = `https://i.ytimg.com/vi/${subject.youtubeId}/hqdefault.jpg`;
    }
    if (subject.subject === 'TRACK' || subject.subject === 'ALBUM') {
      if (!sourceTitle.toLowerCase().includes(subject.title.toLowerCase()) || !sourceTitle.toLowerCase().includes(subject.creatorLabel.toLowerCase())) throw new Error(`Music identity mismatch: ${subject.slug}: ${sourceTitle}`);
    }
  }
  if (!imageUrl || !imageUrl.startsWith('https://')) throw new Error(`No official image: ${subject.slug}`);
  const imageResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
  if (!imageResponse.ok || !imageResponse.headers.get('content-type')?.startsWith('image/')) throw new Error(`Image unavailable: ${subject.slug}`);
  await imageResponse.body?.cancel();
  const metadata = { capturedAt, sourceUrl: metadataUrl, sourceTitle: sourceTitle.trim(), sourceSha256: hash(metadataText), imageUrl,
    imageSourceUrl: subject.youtubeId ? `https://www.youtube.com/watch?v=${subject.youtubeId}` : subject.subjectUrl,
    imageVerifiedAt: new Date().toISOString() };
  let activity = null;
  if (subject.wikipediaArticle) {
    const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia.org/all-access/user/${encodeURIComponent(subject.wikipediaArticle)}/daily/${stamp(oldestRequested)}/${stamp(latestRequested)}`;
    const { text } = await get(url);
    const payload = JSON.parse(text);
    if (!Array.isArray(payload.items) || payload.items.length === 0) throw new Error(`No pageviews for ${subject.slug}`);
    const points = payload.items.map(item => {
      if (item.article !== subject.wikipediaArticle || item.project !== 'en.wikipedia' || item.granularity !== 'daily' || item.agent !== 'user' || item.access !== 'all-access' || !Number.isSafeInteger(item.views) || item.views < 0 || !/^\d{8}00$/.test(item.timestamp)) throw new Error(`Invalid observation: ${subject.slug}`);
      return { date: `${item.timestamp.slice(0,4)}-${item.timestamp.slice(4,6)}-${item.timestamp.slice(6,8)}`, views: item.views };
    }).sort((a,b) => a.date.localeCompare(b.date));
    if (new Set(points.map(point => point.date)).size !== points.length || points.some(point => point.date < oldestRequested || point.date > latestRequested)) throw new Error(`Observation interval mismatch: ${subject.slug}`);
    // Keep prior evidence intact, including later provider corrections for the same date range.
    const rawFile = `raw/${subject.slug}-pageviews-${points[0].date}-${points.at(-1).date}-${capturedAt.replaceAll(/[^0-9]/g, '')}.json`;
    await writeFile(new URL(rawFile, root), text + '\n', { flag: 'wx' });
    activity = { metric: 'WIKIPEDIA_ARTICLE_PAGEVIEWS', project: 'en.wikipedia.org', article: subject.wikipediaArticle,
      access: 'all-access', agent: 'user', granularity: 'daily', sourceUrl: url, capturedAt,
      firstDate: points[0].date, lastDate: points.at(-1).date, rawFile, rawSha256: hash(text + '\n'), points };
  }
  subjects.push({ slug: subject.slug, metadata, activity });
  console.log(`${subject.slug}: verified image; ${activity ? `${activity.points.length} daily observations through ${activity.lastDate}` : 'metadata only'}`);
}
const snapshot = { schemaVersion: 1, capturedAt, requestedPeriod: { from: oldestRequested, to: latestRequested }, subjects };
await writeFile(new URL('snapshot.ts', root), '/** Generated by scripts/refresh-reference-data.mjs from public responses. */\nexport const referenceSnapshot = ' + JSON.stringify(snapshot, null, 2) + ';\n');
console.log(`Saved ${subjects.length} subjects to ${fileURLToPath(root)}`);
