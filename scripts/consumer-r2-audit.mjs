/** Read-only R2 acceptance audit. Baseline gaps are PENDING until integration is supplied. */
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditConsumerSnapshot } from '../apps/web/qa/consumer/audit.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = new Set(['KEYWORD', 'VIDEO', 'TRACK', 'ALBUM', 'ACCOUNT']);
const httpUrl = value => {
  try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; }
};
const read = async (root, relative) => {
  try { return await readFile(path.join(root, relative), 'utf8'); } catch { return null; }
};
const stamp = (status, detail) => ({ status, detail });
const unique = items => new Set(items).size === items.length;

export function auditR2Catalog(scenarios, sampleMarkets, unifiedMarkets = null) {
  const checks = {};
  const slugs = scenarios.map(item => item.slug);
  checks.scenarios = stamp(scenarios.length === 15 && unique(slugs) && scenarios.every(item => types.has(item.subject)) ? 'PASS' : 'FAIL',
    { count: scenarios.length, uniqueSlugs: unique(slugs), subjects: Object.fromEntries([...types].map(type => [type, scenarios.filter(item => item.subject === type).length])) });
  const byId = new Map(sampleMarkets.map(item => [item.id, item]));
  const matched = scenarios.filter(item => byId.has(`demo:market:${item.slug}`));
  checks.stableSampleIds = stamp(matched.length === 15 && sampleMarkets.length === 15 && unique(sampleMarkets.map(item => item.id)) ? 'PASS' : 'PENDING',
    { matched: matched.length, sampleCount: sampleMarkets.length });
  const enriched = sampleMarkets.filter(item => httpUrl(item.subjectUrl) && httpUrl(item.imageSourceUrl) &&
    (item.subject === 'KEYWORD' || (typeof item.creatorLabel === 'string' && item.creatorLabel.trim())) &&
    typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.trim() &&
    typeof item.imageAlt === 'string' && item.imageAlt.trim() &&
    !/\bfictional\b|\bplaceholder\b/i.test(`${item.title} ${item.subtitle}`));
  checks.realSubjectMedia = stamp(enriched.length === 15 ? 'PASS' : 'PENDING',
    { enriched: enriched.length, sampleCount: sampleMarkets.length,
      missingIds: sampleMarkets.filter(item => !enriched.includes(item)).map(item => item.id) });
  checks.sampleProvenance = stamp(sampleMarkets.every(item => item.source?.mode === 'DEMO' && !item.liveMarketId) ? 'PASS' : 'FAIL',
    { invalidIds: sampleMarkets.filter(item => item.source?.mode !== 'DEMO' || item.liveMarketId).map(item => item.id) });
  if (unifiedMarkets === null) {
    checks.unifiedCatalog = stamp('PENDING', 'Supply --catalog-json from the integrated Explore read model; baseline Demo provider is not that catalog.');
  } else {
    const sampleIds = new Set(sampleMarkets.map(item => item.id));
    const ids = unifiedMarkets.map(item => item.id);
    const matchedSampleIds = sampleMarkets.filter(item => ids.includes(item.id)).length;
    const live = unifiedMarkets.filter(item => item.source?.mode === 'LIVE');
    const samples = unifiedMarkets.filter(item => item.source?.mode === 'DEMO');
    checks.unifiedCatalog = stamp(unique(ids) && samples.length === 15 && live.length >= 1 ? 'PASS' : 'FAIL',
      { count: unifiedMarkets.length, uniqueIds: unique(ids), matchedSampleIds, sampleCount: samples.length, liveCount: live.length,
        missingSampleIds: [...sampleIds].filter(id => !ids.includes(id)) });
  }
  return checks;
}

export async function auditR2Source(root) {
  const checks = {};
  const app = await read(root, 'apps/web/src/App.tsx');
  const shell = await read(root, 'apps/web/src/consumer-ui/ConsumerShell.tsx');
  const media = await read(root, 'apps/web/src/media/SubjectImage.tsx');
  const docs = await read(root, 'apps/web/src/docs/index.tsx');
  const publicFiles = ['apps/web/src/App.tsx', 'apps/web/src/consumer-ui/ConsumerShell.tsx',
    'apps/web/src/consumer-ui/copy.ts', 'apps/web/src/social/Social.tsx',
    'apps/web/src/charts/ConsumerChart.tsx', 'apps/web/src/Financial.tsx'];
  const copyHits = [];
  for (const relative of publicFiles) {
    const source = await read(root, relative);
    if (source) for (const [index, line] of source.split(/\r?\n/).entries())
      if (/\bfree[ -]?calls?\b|\bactor and note\b/i.test(line))
        copyHits.push({ file: relative, line: index + 1, excerpt: line.trim().slice(0, 180) });
  }
  checks.customerCopy = stamp(copyHits.length ? 'PENDING' : 'PASS',
    { candidateCount: copyHits.length, candidates: copyHits.slice(0, 30),
      limit: 'Static source candidates need rendered/accessibility review; internal identifiers are allowed.' });
  const toggleTokens = !!app && /onModeChange=/.test(app);
  checks.singleNavigation = stamp(app && shell && !toggleTokens ? 'PASS' : 'PENDING',
    { appPresent: !!app, shellPresent: !!shell, toggleTokens: !!toggleTokens,
      limit: 'A retained but unused legacy mode helper is allowed. Confirm rendered desktop/mobile navigation and old deep links in a browser.' });
  checks.docsRoute = stamp(app && docs && /\/docs/.test(app) && /DocsPage/.test(app) && /\bexport\b[\s\S]*\bDocsPage\b/.test(docs) ? 'PASS' : 'PENDING',
    { modulePresent: !!docs, appRouteToken: !!app && /\/docs/.test(app),
      limit: 'Browser must verify /docs and /docs/:slug deep links and mobile navigation.' });
  checks.mediaFallback = stamp(media && /SubjectImage/.test(media) && /WalletAvatar/.test(media) &&
    /onError|error/i.test(media) ? 'PASS' : 'PENDING',
    { modulePresent: !!media, limit: 'Image failure and avatar identity fallback require rendered checks.' });
  checks.appMarketMediaWiring = stamp(app && /marketMedia\s*=/.test(app) ? 'PASS' : 'PENDING',
    { propPresent: !!app && /marketMedia\s*=/.test(app),
      limit: 'Source wiring token alone does not prove the correct image/title appears on each row.' });
  const social = await read(root, 'apps/web/src/social/Social.tsx');
  checks.closedPlacementSourceRisk = stamp('PENDING',
    { legacyRiskDetected: !!social && /action\.kind\s*===\s*['"]CALL_OPEN['"]\s*\?\s*['"]Open['"]/.test(social),
      limit: 'A placement event can outlive its record. Supply rendered activity rows to prove a closed record is not labeled Active/Open.' });
  checks.liveProfileSourceRisk = stamp('PENDING',
    { sourceCandidate: !!social && /Public free calls|No public free calls|free call leaderboard/i.test(social),
      limit: 'Rendered Live profile text and accessible labels are required.' });
  const docsFiles = [];
  async function collectDocs(relative) {
    const directory = path.join(root, relative);
    try {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const child = path.join(relative, item.name);
        if (item.isDirectory()) await collectDocs(child);
        else if (/\.(?:md|mdx|tsx?)$/i.test(item.name)) docsFiles.push(child);
      }
    } catch { /* module not integrated yet */ }
  }
  await collectDocs('apps/web/src/docs');
  await collectDocs('docs/product');
  const placeholderHits = [];
  for (const relative of docsFiles) {
    const body = await read(root, relative);
    for (const [index, line] of (body ?? '').split(/\r?\n/).entries())
      if (/\bTODO\b|\bTBD\b|\blorem ipsum\b|\bcoming soon\b|\bplaceholder\b/i.test(line))
        placeholderHits.push({ file: relative, line: index + 1, excerpt: line.trim().slice(0, 160) });
  }
  checks.docsPlaceholders = stamp(!docsFiles.length ? 'PENDING' : placeholderHits.length ? 'FAIL' : 'PASS',
    { files: docsFiles.length, hits: placeholderHits.slice(0, 30),
      limit: 'Review hits in context. Browser must confirm complete rendered Docs pages.' });
  checks.executionBoundary = stamp('PENDING',
    'Source scan cannot establish that sample IDs never enter wallet prepare, ranking, settlement or SAS. Verify route capability and read/write traces on integrated App/API.');
  return checks;
}

/** Rendered evidence must come from the integrated App, never inferred from the old sample adapter. */
export function auditR2RegressionEvidence(sampleMarkets, sampleHistories, evidence = null) {
  const checks = {};
  const actions = new Map(sampleHistories.flatMap(history => history?.actions ?? []).map(action => [action.id, action]));
  const closedRecords = new Set([...actions.values()].filter(action => action.kind === 'CALL_CLOSE' && action.recordId).map(action => action.recordId));
  const closedPlacements = [...actions.values()].filter(action => action.kind === 'CALL_OPEN' && closedRecords.has(action.recordId));
  const activityRows = evidence?.activityRows;
  if (!Array.isArray(activityRows)) checks.closedPlacementPresentation = stamp('PENDING',
    { closedPlacementCount: closedPlacements.length, limit: 'Export rendered activity rows for all closed sample records.' });
  else {
    const rows = new Map(activityRows.map(row => [row.actionId, row]));
    const missing = closedPlacements.filter(action => !rows.has(action.id)).map(action => action.id);
    const mislabeled = closedPlacements.filter(action =>
      /\b(?:active|open)\b/i.test(String(rows.get(action.id)?.visibleState ?? ''))).map(action => action.id);
    checks.closedPlacementPresentation = stamp(mislabeled.length ? 'FAIL' : missing.length ? 'PENDING' : 'PASS',
      { closedPlacementCount: closedPlacements.length, missing, mislabeled });
  }
  const avatar = evidence?.svgAvatar;
  checks.avatarSvgFallback = stamp(!avatar ? 'PENDING'
    : /^data:image\/svg\+xml(?:;[^,]*)?,/i.test(avatar.src ?? '') &&
      (Number(avatar.naturalWidth) > 0 || avatar.fallbackVisible === true) ? 'PASS' : 'FAIL',
  avatar ?? 'Supply one rendered SVG data-URI avatar with naturalWidth or an explicit visible fallback.');
  const mediaRows = evidence?.marketMedia;
  if (!Array.isArray(mediaRows)) checks.renderedMarketMedia = stamp('PENDING', 'Supply rendered media/fallback evidence for all 15 sample IDs.');
  else {
    const byId = new Map(mediaRows.map(row => [row.marketId, row]));
    const missing = sampleMarkets.filter(market => !byId.has(market.id)).map(market => market.id);
    const invalid = sampleMarkets.filter(market => {
      const row = byId.get(market.id);
      return row && (!(row.imageVisible || row.fallbackVisible) || row.subjectTitle !== market.title || row.reviewedSubject !== true);
    }).map(market => market.id);
    checks.renderedMarketMedia = stamp(invalid.length ? 'FAIL' : missing.length ? 'PENDING' : 'PASS', { missing, invalid,
      limit: 'reviewedSubject is a manual title/art match, not image license verification.' });
  }
  const noteReviews = evidence?.noteReviews;
  if (!Array.isArray(noteReviews)) checks.noteSubjectFit = stamp('PENDING', 'Review each sample note against its real subject; generic old scenario prose is not automatically appropriate.');
  else {
    const byId = new Map(noteReviews.map(item => [item.marketId, item]));
    const missing = sampleMarkets.filter(market => !byId.has(market.id)).map(market => market.id);
    const mismatched = sampleMarkets.filter(market => {
      const review = byId.get(market.id);
      return review && (review.matched !== true || typeof review.evidence !== 'string' || !review.evidence.trim());
    }).map(market => market.id);
    checks.noteSubjectFit = stamp(mismatched.length ? 'FAIL' : missing.length ? 'PENDING' : 'PASS', { missing, mismatched });
  }
  const liveProfile = evidence?.liveProfile;
  const profileText = liveProfile ? [liveProfile.visibleText, ...(liveProfile.accessibleLabels ?? [])].join(' ') : '';
  checks.liveProfileCopy = stamp(!liveProfile ? 'PENDING'
    : !/^\/u\//.test(liveProfile.route ?? '') || !liveProfile.visibleText?.trim() ||
      /\bfree[ -]?calls?\b/i.test(profileText) ? 'FAIL' : 'PASS',
  liveProfile ? { route: liveProfile.route, residualFreeCall: /\bfree[ -]?calls?\b/i.test(profileText) }
    : 'Supply a rendered Live public profile body and accessible labels.');
  const docsPages = evidence?.docsPages;
  if (!Array.isArray(docsPages)) checks.renderedDocs = stamp('PENDING', 'Supply /docs and topic deep-link reloads at desktop and mobile widths.');
  else {
    const missingHome = !docsPages.some(page => page.route === '/docs');
    const bad = docsPages.filter(page => !page.route?.startsWith('/docs') || !page.visibleText || page.visibleText.length < 30 ||
      /\bTODO\b|\bTBD\b|\blorem ipsum\b|\bcoming soon\b|\bplaceholder\b/i.test(page.visibleText) ||
      page.linkAccessible !== true).map(page => page.route);
    checks.renderedDocs = stamp(bad.length ? 'FAIL' : missingHome || docsPages.length < 8 ? 'PENDING' : 'PASS',
      { count: docsPages.length, missingHome, bad,
        limit: 'Inspect all links and content against current capabilities; this scan only catches placeholders and missing pages.' });
  }
  return checks;
}

export async function auditR2(root = defaultRoot, { catalog = null, readModel = null, regression = null } = {}) {
  const { demoActors, demoScenarioFixtures } = await import(pathToFileURL(path.join(root, 'contracts/fixtures/consumer/catalog.ts')).href);
  const { demoConsumerReadApi } = await import(pathToFileURL(path.join(root, 'apps/web/src/demo/consumerDemo.ts')).href);
  const sampleMarkets = await demoConsumerReadApi.listMarkets();
  const checks = { ...auditR2Catalog(demoScenarioFixtures, sampleMarkets, catalog), ...await auditR2Source(root) };
  const sampleHistories = await Promise.all(sampleMarkets.flatMap(market =>
    ['1D', '1W', '1M', 'ALL'].map(period => demoConsumerReadApi.getHistory(market.id, period))));
  const sampleProfiles = await Promise.all(demoActors.map(actor => demoConsumerReadApi.getProfile(actor.id)));
  const sampleLeaderboards = await Promise.all(['7D', 'ALL'].map(period => demoConsumerReadApi.getLeaderboard(period)));
  const sampleIssues = auditConsumerSnapshot({ markets: sampleMarkets, histories: sampleHistories,
    profiles: sampleProfiles, leaderboards: sampleLeaderboards });
  checks.sampleReadModelIntegrity = stamp(sampleIssues.length ? 'FAIL' : 'PASS',
    { markets: sampleMarkets.length, histories: sampleHistories.length, profiles: sampleProfiles.length,
      leaderboards: sampleLeaderboards.length, findings: sampleIssues,
      limit: 'Tests existing sample adapter only; not the R2 unified catalog or live API.' });
  const regressions = auditR2RegressionEvidence(sampleMarkets, sampleHistories, regression);
  for (const [key, value] of Object.entries(regressions)) checks[key] = value;
  if (readModel === null) checks.readModelIntegrity = stamp('PENDING',
    'Supply --read-model-json with markets/histories/profiles/leaderboards from the integrated adapters.');
  else {
    const findings = auditConsumerSnapshot(readModel);
    checks.readModelIntegrity = stamp(findings.length ? 'FAIL' : 'PASS', { findings });
  }
  const counts = Object.fromEntries(['PASS', 'PENDING', 'FAIL'].map(status =>
    [status.toLowerCase(), Object.values(checks).filter(item => item.status === status).length]));
  return { schemaVersion: 'consumer-r2-qa/1', root, checkedAt: new Date().toISOString(), counts, checks,
    boundary: 'Source and DTO audit only. Browser, public API provenance, physical wallet and chain finality are separate.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = flag => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  const root = path.resolve(option('--root') ?? defaultRoot);
  const catalogFile = option('--catalog-json');
  const readModelFile = option('--read-model-json');
  const regressionFile = option('--regression-json');
  const catalog = catalogFile ? JSON.parse(await readFile(path.resolve(catalogFile), 'utf8')) : null;
  const readModel = readModelFile ? JSON.parse(await readFile(path.resolve(readModelFile), 'utf8')) : null;
  const regression = regressionFile ? JSON.parse(await readFile(path.resolve(regressionFile), 'utf8')) : null;
  if (catalog !== null && !Array.isArray(catalog)) throw new Error('--catalog-json must be a JSON array of rendered Explore market DTOs.');
  const report = await auditR2(root, { catalog, readModel, regression });
  const output = path.join(root, '.runtime/consumer-r2-qa/audit.json');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, counts: report.counts, checks: Object.fromEntries(
    Object.entries(report.checks).map(([key, value]) => [key, value.status])) }, null, 2));
  if (args.includes('--require-integrated') && (report.counts.pending || report.counts.fail)) process.exitCode = 1;
}
