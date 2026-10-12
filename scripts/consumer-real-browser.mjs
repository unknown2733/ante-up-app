/** Production App regression using only public GETs and an isolated headless browser. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceConsumerReadApi } from '../apps/web/src/reference/referenceData.ts';
import { withVerifiedSubjectMedia } from '../apps/web/src/consumer-ui/catalog.ts';

const args = process.argv.slice(2);
const option = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
if (!option('--dist')) throw new Error('Usage: node scripts/consumer-real-browser.mjs --dist apps/web/dist [--api-origin https://ante-up.fun] [--source-sha SHA]');
const dist = path.resolve(option('--dist'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = new URL(option('--api-origin') ?? 'https://ante-up.fun');
if (upstream.origin !== 'https://ante-up.fun' || upstream.pathname !== '/' || upstream.username || upstream.password || upstream.search || upstream.hash)
  throw new Error('Only the public https://ante-up.fun API origin is allowed.');
const getPublic = async pathname => {
  const response = await fetch(new URL(pathname, upstream), { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Public GET ${pathname}: ${response.status}`);
  return response.json();
};
const [references, publicMarkets, publicBoard] = await Promise.all([
  referenceConsumerReadApi.listMarkets(), getPublic('/api/v1/consumer/markets'), getPublic('/api/v1/consumer/leaderboard?period=7D'),
]);
const live = Array.isArray(publicMarkets.data) ? publicMarkets.data.map(withVerifiedSubjectMedia) : publicMarkets.data;
const board = publicBoard.data;
if (!Array.isArray(live) || !Array.isArray(board?.rows)) throw new Error('Unexpected public API response.');
const catalog = [...live, ...references];
const referenceHistories = await Promise.all(references.map(market => referenceConsumerReadApi.getHistory(market.id, 'ALL')));
for (const history of referenceHistories) {
  if (!history || history.source.mode !== 'REFERENCE' || history.actions.length || history.series.length !== 1 ||
      history.series[0].kind !== 'ACTIVITY_COUNT' || !history.series[0].points.length ||
      history.series[0].points.some(point => !Number.isFinite(point.atMs) || !Number.isFinite(Number(point.value))))
    throw new Error('Platform references must contain observed activity counts without synthetic wallet actions.');
}
const allowedImageOrigins = [...new Set(catalog.map(item => {
  try { const url = new URL(item.thumbnailUrl); return url.protocol === 'https:' ? url.origin : null; } catch { return null; }
}).filter(Boolean))];
const runRoot = path.join(root, '.runtime/real-catalog-qa');
await mkdir(runRoot, { recursive: true });
const run = await mkdtemp(path.join(runRoot, 'browser-'));
await writeFile(path.join(run, 'catalog.json'), JSON.stringify(catalog, null, 2));
await writeFile(path.join(run, 'reference-histories.json'), JSON.stringify(referenceHistories, null, 2));
await writeFile(path.join(run, 'public-leaderboard.json'), JSON.stringify(publicBoard, null, 2));
await readFile(path.join(dist, 'index.html'));
const results = [], failures = [], blockedRequests = [], browserErrors = [], publicReads = [];
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  const send = (status, type, body) => { response.writeHead(status, {
    'content-type': type, 'cache-control': 'no-store',
    'content-security-policy': `default-src 'self' data: blob:; connect-src 'self'; img-src 'self' data: ${allowedImageOrigins.join(' ')}; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:`,
  }); response.end(request.method === 'HEAD' ? null : body); };
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!['GET', 'HEAD'].includes(request.method)) { blockedRequests.push({ method: request.method, url: url.pathname }); send(405, 'text/plain', 'Read-only QA'); return; }
    if (url.pathname.startsWith('/api/')) {
      if (!url.pathname.startsWith('/api/v1/') || /\/auth(?:\/|$)/.test(url.pathname)) { send(403, 'text/plain', 'Public reads only'); return; }
      const target = new URL(url.pathname + url.search, upstream);
      const result = await fetch(target, { method: request.method, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      publicReads.push({ path: target.pathname + target.search, status: result.status });
      send(result.status, result.headers.get('content-type') ?? 'application/json', Buffer.from(await result.arrayBuffer())); return;
    }
    let relative;
    try { relative = decodeURIComponent(url.pathname); } catch { send(400, 'text/plain', 'Invalid path'); return; }
    const target = path.resolve(dist, '.' + relative);
    if (target !== dist && !target.startsWith(dist + path.sep)) { send(403, 'text/plain', 'Forbidden'); return; }
    let file = target === dist ? path.join(dist, 'index.html') : target;
    let body;
    try { body = await readFile(file); }
    catch { if (path.extname(file)) { send(404, 'text/plain', 'Not found'); return; } file = path.join(dist, 'index.html'); body = await readFile(file); }
    send(200, mime[path.extname(file)] ?? 'application/octet-stream', body);
  } catch (error) { send(502, 'application/json', JSON.stringify({ error: error.message })); }
});
await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
const base = new URL(`http://127.0.0.1:${server.address().port}`);
const chromePath = process.env.ANTE_UP_CHROMIUM ?? path.join(process.env.USERPROFILE ?? homedir(), 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe');
const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--remote-debugging-port=0', `--user-data-dir=${path.join(run, 'chrome-profile')}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let chromeError = '', socket;
chrome.on('error', error => { chromeError = error.message; });
chrome.stderr.on('data', data => { chromeError = (chromeError + data.toString()).slice(-2000); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let debugPort;
  for (let i = 0; i < 80; i++) { try { debugPort = (await readFile(path.join(run, 'chrome-profile/DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; break; } catch { await delay(100); } }
  if (!debugPort) throw new Error(`Chromium unavailable: ${chromeError}`);
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const tab = targets.find(item => item.type === 'page');
  if (!tab) throw new Error('No Chromium page target.');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let serial = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20_000);
    timer.unref(); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.text);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') browserErrors.push(message.params.entry.text);
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request, resourceType } = message.params;
      const target = new URL(request.url);
      const externalImage = resourceType === 'Image' && target.protocol === 'https:' && allowedImageOrigins.includes(target.origin);
      const allowed = ['GET', 'HEAD'].includes(request.method) && (target.origin === base.origin || externalImage);
      if (!allowed) blockedRequests.push({ method: request.method, url: request.url });
      const headers = Object.entries(request.headers).filter(([name]) => !/^(cookie|authorization|proxy-authorization)$/i.test(name)).map(([name, value]) => ({ name, value }));
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId, headers } : { requestId, errorReason: 'BlockedByClient' }).catch(error => browserErrors.push(error.message));
    }
  });
  for (const method of ['Page.enable', 'Runtime.enable', 'Log.enable']) await send(method);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  const evaluate = async expression => { const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text); return reply.result.value; };
  const probeCode = `(() => {
    const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
    const all=s=>[...document.querySelectorAll(s)].filter(visible);
    const label=e=>e.getAttribute('aria-label')||e.textContent?.trim()||'';
    return {url:location.href,text:document.body.innerText,language:document.documentElement.lang,
      overflow:Math.max(0,document.documentElement.scrollWidth-document.documentElement.clientWidth),
      rows:all('.au-market-row').map(e=>({label:label(e),text:e.innerText,source:e.querySelector('.au-source-cell strong')?.textContent,
        value:e.querySelector('.au-price-cell strong')?.textContent,metric:e.querySelector('.au-price-cell small')?.textContent,change:e.querySelector('.au-change-cell')?.textContent})),
      ranks:all('.au-social-ranks .au-social-actor').map(e=>({address:e.title,label:label(e)})),
      activities:all('.au-social-activity').length,markers:all('.au-chart-marker').length,
      chart:all('.au-chart svg').map(e=>e.getAttribute('aria-label')),chartPoints:all('.au-chart svg circle').length,
      circles:all('.au-chart svg circle').map(e=>({x:Number(e.getAttribute('cx')),y:Number(e.getAttribute('cy'))})),
      lines:all('.au-chart svg polyline').map(e=>e.getAttribute('points')),
      chartCaption:all('.au-chart-caption').map(e=>e.innerText),
      chartObservation:all('.au-chart-history-context').map(e=>e.innerText),
      pointTitles:all('.au-chart svg circle').map(e=>e.textContent),
      observationRows:all('.au-chart-observations tbody tr').map(e=>({date:e.querySelector('time')?.dateTime,value:e.querySelectorAll('td')[1]?.textContent,source:e.querySelector('a')?.href})),
      observationHeaders:all('.au-chart-observations th').map(e=>e.textContent),
      snapshots:all('.au-metric-snapshot,.au-chart-snapshot').map(e=>({text:e.innerText,value:e.querySelector('.au-snapshot-value strong')?.textContent,
        unit:e.querySelector('.au-snapshot-value span')?.textContent,label:e.querySelector('.au-snapshot-label')?.textContent,observedAt:e.querySelector('time')?.dateTime,
        observationLabel:e.querySelector('.au-snapshot-observation')?.textContent})),
      periodControls:all('.au-chart-periods button').length,
      selectedPeriod:all('.au-chart-periods button').find(e=>e.getAttribute('aria-pressed')==='true')?.textContent,
      actionTabs:all('.au-action-tabs [role="tab"]').map(e=>e.textContent.trim()),
      executionControls:all('.au-reference-actions button[aria-describedby="reference-action-reason"]').map(e=>({disabled:e.disabled,text:e.textContent})),
      sources:all('a').filter(e=>e.textContent.includes('View data source')).map(e=>e.href),
      images:all('img').map(e=>({src:e.currentSrc||e.src,complete:e.complete,width:e.naturalWidth})),
      enabledFinancial:all('button').filter(e=>!e.disabled&&!e.hasAttribute('aria-pressed')&&/^(Place chip|Buy|Sell|Open Pro|Deposit liquidity)$/i.test(label(e))).map(label),
      unnamed:all('button,a,input').filter(e=>!label(e)&&!e.getAttribute('placeholder')&&!e.closest('label')).map(e=>e.outerHTML.slice(0,100))};
  })()`;
  async function visit(route, viewport, name, waitFor, navigate = true) {
    if (navigate) await send('Page.navigate', { url: new URL(route, base).href });
    let probe;
    for (let i = 0; i < 80; i++) { await delay(200); probe = await evaluate(probeCode); if (waitFor(probe)) break; }
    await delay(400);
    probe = await evaluate(probeCode);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const image = path.join(run, `${viewport.name}-${name}.png`);
    await writeFile(image, Buffer.from(shot.data, 'base64'));
    results.push({ viewport: viewport.name, route, name, probe, image });
    const check = (condition, message) => { if (!condition) failures.push(`${viewport.name}/${name}: ${message}`); };
    check(waitFor(probe), 'page did not become ready'); check(probe.overflow === 0, `overflow ${probe.overflow}px`);
    check(probe.language === 'en', 'non-English document'); check(probe.unnamed.length === 0, 'unnamed controls');
    check(!/Sample history|Sample data|Example leaderboard|Synthetic examples|Ava · sample|Ben · sample|demo:wallet:/i.test(probe.text), 'fictional content visible');
    check(!probe.images.some(image => image.complete && !image.width), 'broken image');
    return { probe, check };
  }
  function checkReferenceData(view, history) {
    const { probe, check } = view;
    const series = history.series[0];
    const points = [...series.points].sort((a, b) => a.atMs - b.atMs);
    check(probe.enabledFinancial.length === 0, 'executable financial control on reference subject');
    check(probe.markers === 0, 'reference has fabricated chip/trade markers');
    check(probe.actionTabs.join('|') === 'Chips|Buy / Sell|Pro|Liquidity', 'reference action tabs absent');
    check(probe.executionControls.length === 1 && probe.executionControls.every(control => control.disabled), 'unregistered-market execution is not disabled');
    if (points.length === 1 && probe.snapshots.length) {
      const snapshot = probe.snapshots[0];
      const count = new Intl.NumberFormat('en', { maximumFractionDigits: 4 }).format(Number(points[0].value));
      check(snapshot.value === count && snapshot.unit === series.unit && snapshot.label === series.label, 'snapshot count/unit/metric does not match source DTO');
      check(snapshot.observedAt === new Date(points[0].atMs).toISOString(), 'snapshot observation time does not match DTO');
      const observationLabel = series.source.observationLabel ?? history.source.observationLabel;
      if (observationLabel) check(snapshot.observationLabel === observationLabel, 'provider observation/report date context absent');
      check(probe.chartPoints === 0, 'snapshot also presents a historical line chart');
    } else if (points.length) {
      check(probe.chart.length === 1 && probe.chartPoints === points.length, `chart point count differs from DTO (${probe.chartPoints}/${points.length})`);
      check(probe.chart.some(label => label.includes(series.unit)), `chart unit differs from ${series.unit}`);
      if (points.length > 1) check(probe.periodControls === 4, 'history period controls absent');
      if (series.timeBasis === 'REPORT_DATE') {
        check(probe.chartCaption.every(caption => !/\bUTC\b|\b[AP]M\b|\d{1,2}:\d{2}/.test(caption)), 'date-only report axis invents a time or timezone');
        check(probe.pointTitles.every(title => !/\bUTC\b|\b[AP]M\b|\d{1,2}:\d{2}/.test(title)), 'date-only point label invents a time or timezone');
        check(probe.chartObservation.some(label => label.includes(series.aggregation === 'daily' ? 'Daily activity' : 'Cumulative activity') && label.includes('no live feed')), 'aggregation/report-date context absent');
        if (series.observationNote) check(probe.chartObservation.some(label => label.includes(series.observationNote)), 'source history scope absent');
      }
      for (const line of probe.lines) {
        const indices = line.trim().split(/\s+/).map(pair => {
          const [x, y] = pair.split(',').map(Number);
          return probe.circles.findIndex(circle => Math.abs(circle.x - x) < 0.001 && Math.abs(circle.y - y) < 0.001);
        });
        for (let i = 1; i < indices.length; i++) {
          const a = points[indices[i - 1]], b = points[indices[i]];
          check(!!a && !!b, 'rendered line lacks matching source points');
          if (a && b) check(!series.gaps.some(gap => a.atMs <= gap.fromMs && b.atMs >= gap.toMs), 'line crosses a missing-source interval');
        }
      }
    } else check(probe.chartPoints === 0, 'empty period shows invented observations');
  }
  async function checkReferenceEvidence(view, history) {
    await evaluate("document.querySelector('.au-chart-source')?.setAttribute('open','');document.querySelector('.au-chart-observations')?.setAttribute('open','')");
    const evidence = await evaluate(probeCode);
    const series = history.series[0];
    view.check(evidence.sources.includes(series.source.sourceUrl ?? history.source.sourceUrl), 'public provenance link absent');
    if (series.timeBasis === 'REPORT_DATE') {
      view.check(evidence.observationHeaders.includes(series.unit), 'visible observation table unit absent');
      const expected = series.points.map(point => ({ date: point.reportedDate, value: new Intl.NumberFormat('en', { maximumFractionDigits: 4 }).format(Number(point.value)), source: point.sourceUrl }));
      view.check(JSON.stringify(evidence.observationRows) === JSON.stringify(expected), 'date/value/source observation table differs from source DTO');
    }
    results.at(-1).evidence = { sources: evidence.sources, observationRows: evidence.observationRows };
  }
  const shortActor = actor => actor.length > 18 ? `${actor.slice(0, 7)}…${actor.slice(-5)}` : actor;
  const viewports = [{ name: 'desktop-1440', width: 1440, height: 900, mobile: false }, { name: 'mobile-390', width: 390, height: 844, mobile: true }, { name: 'mobile-320', width: 320, height: 568, mobile: true }];
  for (const viewport of viewports) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
    await send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile, maxTouchPoints: viewport.mobile ? 5 : 1 });
    const explore = await visit('/markets', viewport, 'explore', state => state.rows.length === catalog.length);
    explore.check(explore.probe.rows.filter(row => row.source === 'Public source').length === references.length, 'reference row count mismatch');
    explore.check(explore.probe.rows.filter(row => row.source === 'Devnet observed').length === live.length, 'live row count mismatch');
    for (const market of references) {
      const row = explore.probe.rows.find(row => row.label === `Open ${market.title} subject`);
      const count = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(Number(market.activity.value));
      explore.check(row?.value === `${count} ${market.activity.unit}`, `exact platform count/unit absent for ${market.id}`);
      explore.check(row?.metric === market.activity.label, `metric label absent for ${market.id}`);
      if (market.activity.changeFraction === null) explore.check(!!row && !row.change.includes('%'), `inferred percentage change for ${market.id}`);
    }
    const posts = references.filter(market => market.subject === 'POST');
    const clicked = await evaluate("(() => {const e=[...document.querySelectorAll('.au-subject-filter button')].find(e=>e.textContent.trim()==='Post');if(!e)return false;e.click();return true})()");
    explore.check(clicked, 'Post subject filter absent');
    if (clicked) {
      const filtered = await visit('/markets', viewport, 'post-filter', state => state.rows.length === posts.length, false);
      filtered.check(filtered.probe.rows.every(row => posts.some(market => row.label === `Open ${market.title} subject`)), 'Post filter includes a different subject type');
    }
    for (const [index, market] of references.entries()) {
      const history = referenceHistories[index];
      const multiPoint = history.series[0].points.length > 1;
      const detail = await visit(`/markets/${encodeURIComponent(market.id)}?period=ALL`, viewport, `reference-${index}`, state => state.text.includes(market.title) && state.text.includes('PUBLIC SOURCE') && (multiPoint ? state.chartPoints === history.series[0].points.length : state.snapshots.length === 1));
      if (market.thumbnailUrl) {
        for (let attempt = 0; attempt < 40; attempt++) {
          const imageReady = await evaluate(`(() => {const e=document.querySelector('.au-detail-art');return !!e&&e.complete&&e.naturalWidth>0})()`);
          if (imageReady) break;
          await delay(200);
        }
        const imageState = await evaluate(probeCode);
        detail.check(imageState.images.some(image => image.src === market.thumbnailUrl && image.complete && image.width > 0), 'catalog artwork did not load');
        results.at(-1).loadedImages = imageState.images;
      }
      checkReferenceData(detail, history);
      await checkReferenceEvidence(detail, history);
      if (multiPoint) for (const period of ['1D', '1W', '1M']) {
        const expected = await referenceConsumerReadApi.getHistory(market.id, period);
        const clicked = await evaluate(`(() => {const e=[...document.querySelectorAll('.au-chart-periods button')].find(e=>e.textContent===${JSON.stringify(period)});if(!e)return false;e.click();return true})()`);
        detail.check(clicked, `${period} period control absent`);
        if (!clicked) continue;
        const count = expected.series[0].points.length;
        const filtered = await visit(`/markets/${encodeURIComponent(market.id)}?period=${period}`, viewport, `reference-${index}-${period}`, state => state.selectedPeriod === period && (count > 1 ? state.chartPoints === count : count === 1 ? state.chartPoints === 1 || state.snapshots.length === 1 : state.chartPoints === 0), false);
        checkReferenceData(filtered, expected);
        await checkReferenceEvidence(filtered, expected);
        filtered.check(new URL(filtered.probe.url).searchParams.get('period') === period, 'period filter not reflected in URL');
      }
    }
    for (const [index, market] of live.entries()) {
      const detail = await visit(`/markets/${encodeURIComponent(market.id)}`, viewport, `live-${index}`, state => state.text.includes(market.title) && state.text.includes('DEVNET OBSERVED MARKET'));
      detail.check(!detail.probe.text.includes('Fictional sample'), 'fictional live detail');
    }
    const ranking = await visit('/leaderboard', viewport, 'leaderboard', state => state.ranks.length === board.rows.length && state.text.includes('Devnet records'));
    ranking.check(JSON.stringify(ranking.probe.ranks.map(row => row.address)) === JSON.stringify(board.rows.map(row => row.actorId)), 'ranked wallets differ from public API');
    for (const [index, row] of board.rows.entries()) {
      const profile = await getPublic(`/api/v1/consumer/profiles/${encodeURIComponent(row.actorId)}`);
      const expectedActions = profile.data.actions.filter(action => action.source.mode === 'LIVE' && action.actorId === row.actorId && ['CALL_OPEN', 'CALL_CLOSE'].includes(action.kind));
      const shown = await visit(`/u/${encodeURIComponent(row.actorId)}`, viewport, `wallet-${index}`, state => state.text.includes(shortActor(row.actorId)) && state.text.includes('Devnet records'));
      shown.check(shown.probe.activities === expectedActions.length, `activity count differs from public profile: ${shown.probe.activities}/${expectedActions.length}`);
    }
    console.log(JSON.stringify({ viewport: viewport.name, capturedViews: results.length, failures: failures.length }));
  }
  if (blockedRequests.length) failures.push(`${blockedRequests.length} disallowed requests attempted and blocked`);
  if (browserErrors.length) failures.push(`${browserErrors.length} browser errors`);
  const output = path.join(run, 'report.json');
  await writeFile(output, JSON.stringify({ sourceSha: option('--source-sha'), baseUrl: base.origin, upstream: upstream.origin, run,
    allowedImageOrigins, liveCount: live.length, referenceCount: references.length, walletCount: board.rows.length,
    results, failures, browserErrors, blockedRequests, publicReads,
    boundary: 'Built local App with public GET API data and catalog media only. No user browser, wallet, authentication, write request, or transaction.' }, null, 2));
  console.log(JSON.stringify({ output, views: results.length, failureCount: failures.length, firstFailures: failures.slice(0, 30) }, null, 2));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  const output = path.join(run, 'report.json');
  await writeFile(output, JSON.stringify({ fatalError: error.message, results, failures, blockedRequests, browserErrors, publicReads }, null, 2));
  console.error(JSON.stringify({ output, fatalError: error.message, capturedViews: results.length })); process.exitCode = 1;
} finally { socket?.close(); chrome.kill(); server.closeAllConnections(); server.close(); }
