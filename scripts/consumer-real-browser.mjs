/** Production App regression using only public GETs and an isolated headless browser. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createObservedReferenceReadApi } from '../apps/web/src/reference/observedReference.ts';
import { marketDisplayTitle, withVerifiedSubjectMedia } from '../apps/web/src/consumer-ui/catalog.ts';

const args = process.argv.slice(2);
const focusTrends = args.includes('--focus-trends');
const focusIllustrative = args.includes('--focus-illustrative');
const focusCompact = args.includes('--focus-compact');
const focusPages = args.includes('--focus-pages');
const focusTransactions = args.includes('--focus-transactions');
const desktopOnly = args.includes('--desktop-only');
const option = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
if (!option('--dist')) throw new Error('Usage: node scripts/consumer-real-browser.mjs --dist apps/web/dist [--api-origin https://ante-up.fun] [--source-sha SHA]');
const dist = path.resolve(option('--dist'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = new URL(option('--api-origin') ?? 'https://ante-up.fun');
const referenceReadApi = createObservedReferenceReadApi(new URL('/api', upstream).href);
const localReadOnlyProxy = upstream.protocol === 'http:' && upstream.hostname === '127.0.0.1' && upstream.port;
if ((!localReadOnlyProxy && upstream.origin !== 'https://ante-up.fun') || upstream.pathname !== '/' ||
    upstream.username || upstream.password || upstream.search || upstream.hash)
  throw new Error('Only the public https://ante-up.fun origin or an explicit local read-only QA proxy is allowed.');
const getPublic = async pathname => {
  const response = await fetch(new URL(pathname, upstream), { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Public GET ${pathname}: ${response.status}`);
  return response.json();
};
const [references, publicMarkets, publicBoard] = await Promise.all([
  referenceReadApi.listMarkets(), getPublic('/api/v1/consumer/markets'), getPublic('/api/v1/consumer/leaderboard?period=7D'),
]);
const live = Array.isArray(publicMarkets.data) ? publicMarkets.data.map(withVerifiedSubjectMedia) : publicMarkets.data;
const board = publicBoard.data;
if (!Array.isArray(live) || !Array.isArray(board?.rows)) throw new Error('Unexpected public API response.');
const catalog = [...live, ...references];
const referenceHistories = await Promise.all(references.map(market => referenceReadApi.getHistory(market.id, 'ALL')));
const livePreviewHistories = await Promise.all(live.map(async market => (await getPublic(`/api/v1/consumer/markets/${encodeURIComponent(market.id)}/history?period=1W`)).data));
const previewHistories = new Map([...referenceHistories, ...livePreviewHistories].map(history => [history.market.id, history]));
const previewSeries = history => history.series.find(series => history.source.mode === 'REFERENCE' && series.evidence === 'ILLUSTRATIVE' && series.points.length)
  ?? (history.source.mode === 'LIVE' ? ['CURVE_PRICE', 'REFERENCE_PRICE', 'TRADE_PRICE', 'ATTENTION_INDEX', 'ACTIVITY_COUNT'] : ['ACTIVITY_COUNT', 'ATTENTION_INDEX', 'CURVE_PRICE', 'REFERENCE_PRICE', 'TRADE_PRICE']).map(kind => history.series.find(series => series.kind === kind && series.points.length)).find(Boolean);
const expectedSparkCount = [...previewHistories.values()].filter(history => (previewSeries(history)?.points.length ?? 0) > 1).length;
for (const history of referenceHistories) {
  if (!history || history.source.mode !== 'REFERENCE' || history.actions.length || ![1, 2].includes(history.series.length) ||
      history.series[0].kind !== 'ACTIVITY_COUNT' || !history.series[0].points.length ||
      history.series[0].evidence === 'ILLUSTRATIVE' || history.series.slice(1).some(series => series.evidence !== 'ILLUSTRATIVE') ||
      history.series.some(series => series.points.some(point => !Number.isFinite(point.atMs) || !Number.isFinite(Number(point.value)))))
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
await writeFile(path.join(run, 'live-preview-histories.json'), JSON.stringify(livePreviewHistories, null, 2));
await writeFile(path.join(run, 'public-leaderboard.json'), JSON.stringify(publicBoard, null, 2));
await readFile(path.join(dist, 'index.html'));
const results = [], failures = [], blockedRequests = [], browserErrors = [], publicReads = [];
const servedHistories = new Map();
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
      const body = Buffer.from(await result.arrayBuffer());
      const record = { path: target.pathname + target.search, status: result.status };
      if (result.ok && /\/history$/.test(target.pathname)) {
        const payload = JSON.parse(body.toString('utf8'));
        record.history = payload.data;
        servedHistories.set(`${payload.data.market.id}:${target.searchParams.get('period')}`, payload.data);
      }
      publicReads.push(record);
      send(result.status, result.headers.get('content-type') ?? 'application/json', body); return;
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
        value:e.querySelector('.au-price-cell strong')?.textContent,metric:e.querySelector('.au-price-cell small')?.textContent,
        spark:(()=>{const s=e.querySelector('.au-sparkline'),svg=s?.querySelector('svg');return s?{id:s.dataset.marketId,kind:s.dataset.seriesKind,text:s.innerText,visible:!!svg&&visible(svg),description:svg?.getAttribute('aria-label'),
          points:[...s.querySelectorAll('.au-sparkline-point')].map(p=>({atMs:Number(p.dataset.atMs),value:Number(p.dataset.value)})),
          lines:[...s.querySelectorAll('.au-sparkline-segment')].map(p=>({fromMs:Number(p.dataset.fromMs),toMs:Number(p.dataset.toMs)}))}:null})()})),
      ranks:all('.au-social-ranks .au-social-actor').map(e=>({address:e.title,label:label(e)})),
      activities:all('.au-social-activity').length,markers:all('.au-chart-marker').length,
      chart:all('.au-chart svg').map(e=>e.getAttribute('aria-label')),chartPoints:all('.au-chart svg circle').length,
      circles:all('.au-chart svg circle').map(e=>({x:Number(e.getAttribute('cx')),y:Number(e.getAttribute('cy'))})),
      lines:all('.au-chart svg polyline').map(e=>e.getAttribute('points')),
      chartCaption:all('.au-chart-caption').map(e=>e.innerText),
      chartObservation:all('.au-chart-history-context').map(e=>e.innerText),
      illustrativeExplanation:document.querySelector('.au-chart-illustrative')?.textContent||'',
      observationRows:all('.au-chart-observations tbody tr').map(e=>({date:e.querySelector('time')?.dateTime,value:e.querySelectorAll('td')[1]?.textContent,source:e.querySelector('a')?.href})),
      observationHeaders:all('.au-chart-observations th').map(e=>e.textContent),
      snapshots:all('.au-metric-snapshot,.au-chart-snapshot').map(e=>({text:e.innerText,value:e.querySelector('.au-snapshot-value strong')?.textContent,
        unit:e.querySelector('.au-snapshot-value span')?.textContent,label:e.querySelector('.au-snapshot-label')?.textContent,observedAt:e.querySelector('time')?.dateTime,
        observationLabel:e.querySelector('.au-snapshot-observation')?.textContent})),
      periodControls:all('.au-chart-periods button').length,
      selectedPeriod:all('.au-chart-periods button').find(e=>e.getAttribute('aria-pressed')==='true')?.textContent,
      actionTabs:all('.au-action-tabs [role="tab"]').map(e=>e.textContent.trim()),
      chartBeforeActions:(()=>{const chart=document.querySelector('.au-chart'),actions=document.querySelector('.au-action-tabs');return !!chart&&!!actions&&!!(chart.compareDocumentPosition(actions)&Node.DOCUMENT_POSITION_FOLLOWING)})(),
      chartViewport:(()=>{const e=document.querySelector('.au-chart svg,.au-chart-snapshot');if(!e)return null;const r=e.getBoundingClientRect();const overlays=[...document.querySelectorAll('nav')].filter(n=>getComputedStyle(n).position==='fixed').map(n=>n.getBoundingClientRect()).filter(n=>n.top>innerHeight/2);const unobscuredBottom=Math.min(innerHeight,...overlays.map(n=>n.top));const visibleHeight=Math.max(0,Math.min(r.bottom,unobscuredBottom)-Math.max(r.top,60));return {top:r.top,bottom:r.bottom,height:r.height,unobscuredBottom,visibleHeight,inView:visibleHeight>0}})(),
      layout:(()=>{const names=['.au-trading-workspace','.au-action-tabs','.au-trading-chart','.au-chart','.au-chart-value-summary'];return Object.fromEntries(names.map(name=>{const e=document.querySelector(name);if(!e)return[name,null];const r=e.getBoundingClientRect(),c=getComputedStyle(e);return[name,{top:r.top,bottom:r.bottom,marginTop:c.marginTop,paddingTop:c.paddingTop,position:c.position,topRule:c.top}]}))})(),
      chartSummary:all('.au-chart-value-summary').map(e=>e.innerText),
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
  function checkReferenceData(view, history, series = history.series[0]) {
    const { probe, check } = view;
    const illustrative = series.evidence === 'ILLUSTRATIVE';
    const points = [...series.points].sort((a, b) => a.atMs - b.atMs);
    check(probe.enabledFinancial.length === 0, 'executable financial control on reference subject');
    check(probe.markers === 0, 'reference has fabricated chip/trade markers');
    check(probe.actionTabs.join('|') === 'Chips|Buy / Sell|Pro|Liquidity', 'reference action tabs absent');
    check(probe.chartBeforeActions, 'source chart does not precede trading actions');
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
      if (points.length > 1) check(probe.periodControls === 4 || (probe.periodControls === 0 && probe.text.includes('Chart controls')), 'history period controls absent');
      if (illustrative) {
        check(probe.text.includes('Illustrative') && probe.chart.some(label => /illustrative/i.test(label)), 'illustrative chart lacks explicit visible/accessibility label');
        check(probe.chartSummary.some(text => text.includes(series.unit)), 'illustrative metric unit absent');
        check(probe.illustrativeExplanation.includes('not measured activity'), 'illustrative chart lacks measured-data distinction');
        const format = value => new Intl.NumberFormat('en', { maximumFractionDigits: 4 }).format(value);
        const range = `${format(Math.min(...points.map(point => Number(point.value))))} to ${format(Math.max(...points.map(point => Number(point.value))))} ${series.unit}`;
        check(probe.chart.some(label => label.includes(range)), 'illustrative accessible range differs from its explicit preview DTO');
        check(!probe.observationRows.length, 'illustrative series is presented as recorded source observations');
      } else if (series.timeBasis === 'REPORT_DATE') {
        check(probe.chartCaption.every(caption => !/\bUTC\b|\b[AP]M\b|\d{1,2}:\d{2}/.test(caption)), 'date-only report axis invents a time or timezone');
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
    if (desktopOnly && viewport.mobile) continue;
    if (focusCompact && !viewport.mobile) continue;
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
    await send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile, maxTouchPoints: viewport.mobile ? 5 : 1 });
    if (focusCompact) {
      const titles = viewport.width === 320 ? ['Bonobo - Kerala (Official Audio)', 'NASA’s Artemis I Moon Mission: Launch to Splashdown Highlights', 'Awake', 'Rosewood', 'May Ninth'] : ['Bonobo - Kerala (Official Audio)'];
      for (const [index, title] of titles.entries()) {
        const history = referenceHistories.find(item => item.market.title === title);
        if (!history) throw new Error(`Missing compact QA subject: ${title}`);
        const selected = previewSeries(history), actual = history.series[0];
        const route = `/markets/${encodeURIComponent(history.market.id)}/trade?period=ALL`;
        const detail = await visit(route, viewport, `compact-${index}`, state => state.chartPoints === selected.points.length && state.actionTabs.length === 4);
        checkReferenceData(detail, history, selected);
        detail.check(!!detail.probe.chartViewport?.inView, 'default chart outside unobscured initial trading viewport');
        await evaluate("document.querySelector('.au-mobile-chart-controls')?.click()");
        await delay(100);
        const expanded = await evaluate("[...document.querySelectorAll('.au-chart-periods button')].filter(button=>button.getBoundingClientRect().width>0).length===4");
        detail.check(expanded, 'compact chart controls do not reveal the four periods');
        const clicked = await evaluate(`(() => {const e=[...document.querySelectorAll('.au-chart-series button')].find(e=>e.title===${JSON.stringify(actual.label)}||e.textContent.trim()===${JSON.stringify(actual.label)});if(!e)return false;e.click();return true})()`);
        detail.check(clicked, 'actual observed series toggle absent');
        const observed = await visit(route, viewport, `compact-${index}-observed`, state => actual.points.length === 1 ? state.snapshots.length === 1 : state.chartPoints === actual.points.length, false);
        checkReferenceData(observed, history);
        await checkReferenceEvidence(observed, history);
      }
      console.log(JSON.stringify({ viewport: viewport.name, capturedViews: results.length, failures: failures.length }));
      continue;
    }
    if (focusTransactions) {
      for (const market of live.filter(item => item.id === item.liveMarketId)) {
        const current = (await getPublic(`/api/v1/markets/${encodeURIComponent(market.id)}`)).data;
        const chipAllowed = current.capabilities.openFree?.allowed === true;
        const chip = await visit(`/markets/${encodeURIComponent(market.id)}`, viewport, `wallet-chip-${market.id.slice(0, 6)}`, state => state.actionTabs.length === 4 && (chipAllowed ? state.text.includes('Connect wallet to place chip') : true));
        if (chipAllowed) {
          chip.check(chip.probe.text.includes('Connect wallet to place chip'), 'disconnected chip has no direct wallet action');
          const walletButton = await evaluate("(() => { const button=[...document.querySelectorAll('button')].find(item=>item.textContent?.trim()==='Connect wallet to place chip'); if(!button)return false; button.click(); return true; })()");
          await delay(100);
          chip.check(walletButton && await evaluate("!!document.querySelector('.wallet-menu')"), 'chip wallet action did not open the connection menu');
        }
        for (const [section, action] of [['trade', current.phase === 'INDEXED' ? 'spotBuy' : 'curveBuy'], ['pro', 'openPro'], ['lp', 'depositLP']]) {
          const allowed = current.capabilities[action]?.allowed === true;
          const view = await visit(`/markets/${encodeURIComponent(market.id)}/${section}`, viewport, `wallet-${section}-${market.id.slice(0, 6)}`, state => state.actionTabs.length === 4 && (allowed ? state.text.includes('Connect wallet to trade') : true));
          if (allowed) view.check(view.probe.text.includes('Connect wallet to trade'), `${section} has no direct wallet action`);
          else view.check(!view.probe.text.includes('Connect wallet to trade'), `${section} bypasses a closed market stage`);
        }
      }
      for (const [route, label] of [['/faucet', 'Connect wallet to get tUSD'], ['/register', 'Connect wallet to register a market']]) {
        const view = await visit(route, viewport, `wallet-${route.slice(1)}`, state => state.text.includes(label));
        view.check(view.probe.text.includes(label), `${route} has no direct wallet action`);
      }
      console.log(JSON.stringify({ viewport: viewport.name, capturedViews: results.length, failures: failures.length }));
      continue;
    }
    const explore = await visit('/markets', viewport, 'explore', state => state.rows.length === catalog.length && state.rows.filter(row => row.spark?.visible).length === expectedSparkCount);
    explore.check(explore.probe.rows.filter(row => row.source === 'Public source').length === references.length, 'reference row count mismatch');
    explore.check(explore.probe.rows.filter(row => live.some(market => market.id === row.spark?.id)).length === live.length, 'live row count mismatch');
    for (const market of references) {
      const row = explore.probe.rows.find(row => row.label === `Open ${market.title} subject`);
      const count = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(Number(market.activity.value));
      explore.check(row?.value === `${count} ${market.activity.unit}`, `exact platform count/unit absent for ${market.id}`);
      explore.check(row?.metric === market.activity.label, `metric label absent for ${market.id}`);
    }
    for (const row of explore.probe.rows) {
      const history = servedHistories.get(`${row.spark?.id}:1W`) ?? previewHistories.get(row.spark?.id);
      const series = history && previewSeries(history);
      if (!series) {
        explore.check(!row.spark?.visible && !row.spark?.points.length && row.spark?.text.includes('History not available'), `missing history is not disclosed: ${row.label}`);
        continue;
      }
      const expected = [...series.points].filter(point => point.atMs <= series.source.asOfMs).sort((a, b) => a.atMs - b.atMs).map(point => ({ atMs: point.atMs, value: Number(point.value) }));
      if (expected.length < 2) {
        explore.check(!row.spark.visible && !row.spark.points.length && !row.spark.lines.length && row.spark.text.includes('History not available'), `snapshot has an invented trend: ${row.label}`);
      } else {
        explore.check(row.spark.visible && row.spark.kind === series.kind, `genuine trend hidden or wrong metric: ${row.label}`);
        explore.check(JSON.stringify(row.spark.points) === JSON.stringify(expected), `sparkline points differ from source: ${row.label}`);
        explore.check(series.evidence === 'ILLUSTRATIVE' ? /illustrative/i.test(row.spark.text) && /illustrative/i.test(row.spark.description) && /not measured/i.test(row.spark.description) : row.spark.description.includes(series.label) && row.spark.text.includes('First → last observation'), `sparkline change basis absent: ${row.label}`);
        for (const line of row.spark.lines) explore.check(!series.gaps.some(gap => line.fromMs < gap.toMs && line.toMs > gap.fromMs), `sparkline connects a source gap: ${row.label}`);
      }
    }
    if (focusPages) {
      const pages = [
        ['/docs', 'docs', 'Know what your chip means.'],
        ['/docs/start', 'docs-start', 'Explore, place a chip, and find your record.'],
        ['/faucet', 'faucet', 'Get ready to play'],
        ['/register', 'register', 'Register a keyword'],
        ['/leaderboard', 'leaderboard', 'Leaderboard'],
        ['/me', 'my-activity', 'Connect your wallet to view your activity.'],
      ];
      const actor = board.rows[0]?.actorId;
      if (actor) {
        pages.push([`/u/${encodeURIComponent(actor)}`, 'public-profile', 'PUBLIC PROFILE']);
        const profile = await getPublic(`/api/v1/consumer/profiles/${encodeURIComponent(actor)}`);
        const recordAction = profile.data.actions.find(action => action.recordId);
        if (recordAction) {
          const subject = live.find(market => market.id === recordAction.marketId)?.title;
          pages.push([`/records/${encodeURIComponent(recordAction.recordId)}`, 'public-record', subject ? marketDisplayTitle(subject) : 'CHIP RECORD']);
        }
      }
      for (const [route, name, marker] of pages) await visit(route, viewport, name, state => state.text.includes(marker));
      console.log(JSON.stringify({ viewport: viewport.name, capturedViews: results.length, failures: failures.length }));
      continue;
    }
    if (focusIllustrative) {
      let checkedPeriods = false;
      for (const [index, history] of referenceHistories.entries()) {
        const selected = previewSeries(history);
        const route = `/markets/${encodeURIComponent(history.market.id)}/trade?period=ALL`;
        const detail = await visit(route, viewport, `illustrative-${index}`, state => state.chartPoints === selected.points.length && state.actionTabs.length === 4);
        checkReferenceData(detail, history, selected);
        detail.check(!!detail.probe.chartViewport?.inView, 'default chart outside unobscured initial trading viewport');
        if (history.market.thumbnailUrl) {
          for (let attempt = 0; attempt < 40; attempt++) {
            if (await evaluate("(() => {const e=document.querySelector('.au-detail-art');return !!e&&e.complete&&e.naturalWidth>0})()")) break;
            await delay(200);
          }
          const artwork = (await evaluate(probeCode)).images;
          detail.check(artwork.some(image => image.src === history.market.thumbnailUrl && image.complete && image.width > 0), 'catalog artwork did not load');
          results.at(-1).loadedImages = artwork;
        }
        if (selected.evidence === 'ILLUSTRATIVE') {
          const actual = history.series[0];
          const clicked = await evaluate(`(() => {const e=[...document.querySelectorAll('.au-chart-series button')].find(e=>e.title===${JSON.stringify(actual.label)}||e.textContent.trim()===${JSON.stringify(actual.label)});if(!e)return false;e.click();return true})()`);
          detail.check(clicked, 'actual observed series toggle absent');
          const observed = await visit(route, viewport, `observed-${index}`, state => actual.points.length === 1 ? state.snapshots.length === 1 : state.chartPoints === actual.points.length, false);
          checkReferenceData(observed, history);
          await checkReferenceEvidence(observed, history);
          if (!checkedPeriods) {
            checkedPeriods = true;
            for (const period of ['1D', '1W', '1M']) {
              const expected = await referenceReadApi.getHistory(history.market.id, period);
              const expectedSeries = previewSeries(expected);
              const filtered = await visit(`/markets/${encodeURIComponent(history.market.id)}/trade?period=${period}`, viewport, `illustrative-period-${period}`, state => state.selectedPeriod === period && state.chartPoints === expectedSeries.points.length);
              checkReferenceData(filtered, expected, expectedSeries);
            }
          }
        } else await checkReferenceEvidence(detail, history);
      }
      console.log(JSON.stringify({ viewport: viewport.name, capturedViews: results.length, failures: failures.length }));
      continue;
    }
    if (!focusTrends) {
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
      const initial = previewSeries(history);
      const detailRoute = `/markets/${encodeURIComponent(market.id)}?period=ALL`;
      let detail = await visit(detailRoute, viewport, `reference-${index}`, state => state.text.includes(market.title) && state.text.includes('PUBLIC SOURCE') && (initial.points.length > 1 ? state.chartPoints === initial.points.length : state.snapshots.length === 1));
      if (initial.evidence === 'ILLUSTRATIVE') {
        checkReferenceData(detail, history, initial);
        const clicked = await evaluate(`(() => {const e=[...document.querySelectorAll('.au-chart-series button')].find(e=>e.title===${JSON.stringify(history.series[0].label)}||e.textContent.trim()===${JSON.stringify(history.series[0].label)});if(!e)return false;e.click();return true})()`);
        detail.check(clicked, 'actual observed series toggle absent');
        detail = await visit(detailRoute, viewport, `reference-${index}-observed`, state => multiPoint ? state.chartPoints === history.series[0].points.length : state.snapshots.length === 1, false);
      }
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
        const expected = await referenceReadApi.getHistory(market.id, period);
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
      const hasHistory = !!previewSeries(previewHistories.get(market.id))?.points.length;
      const detail = await visit(`/markets/${encodeURIComponent(market.id)}`, viewport, `live-${index}`, state => state.text.includes(marketDisplayTitle(market.title)) && state.actionTabs.length === 4 && (hasHistory ? state.chartPoints > 0 : state.text.includes('No observed chart data in this period')));
      detail.check(!detail.probe.text.includes('Fictional sample'), 'fictional live detail');
      detail.check(detail.probe.chartBeforeActions && (hasHistory ? !!detail.probe.chartViewport?.inView : detail.probe.text.includes('No observed chart data in this period')), 'live chart or explicit missing-history state absent before actions');
    }
    }
    if (focusTrends && !viewport.mobile) {
      console.log(JSON.stringify({ viewport: viewport.name, capturedViews: results.length, failures: failures.length }));
      continue;
    }
    const routeSubjects = [referenceHistories.find(history => history.series[0].aggregation === 'daily'),
      referenceHistories.find(history => history.series[0].aggregation === 'cumulative'),
      !focusTrends && referenceHistories.find(history => history.series[0].points.length === 1)].filter(Boolean);
    for (const history of routeSubjects) for (const section of ['trade', 'pro', 'lp']) {
      const route = `/markets/${encodeURIComponent(history.market.id)}/${section}?period=ALL`;
      const initial = previewSeries(history);
      const view = await visit(route, viewport, `route-${history.series[0].aggregation ?? 'snapshot'}-${section}`, state => state.actionTabs.length === 4 && (initial.points.length > 1 ? state.chartPoints === initial.points.length : state.snapshots.length === 1));
      checkReferenceData(view, history, initial);
      view.check(!!view.probe.chartViewport?.inView, 'reference chart/snapshot outside initial trading viewport');
    }
    for (const [index, market] of live.entries()) for (const section of ['trade', 'pro', 'lp']) {
      const hasHistory = !!previewSeries(previewHistories.get(market.id))?.points.length;
      const view = await visit(`/markets/${encodeURIComponent(market.id)}/${section}`, viewport, `live-${index}-${section}`, state => state.actionTabs.length === 4 && (hasHistory ? state.chartPoints > 0 : state.text.includes('No observed chart data in this period')));
      view.check(view.probe.chartBeforeActions && (hasHistory ? !!view.probe.chartViewport?.inView : view.probe.text.includes('No observed chart data in this period')), 'live chart or explicit missing-history state absent before trading actions');
    }
    if (!focusTrends) {
    const ranking = await visit('/leaderboard', viewport, 'leaderboard', state => state.ranks.length === board.rows.length && state.text.includes('Devnet records'));
    ranking.check(JSON.stringify(ranking.probe.ranks.map(row => row.address)) === JSON.stringify(board.rows.map(row => row.actorId)), 'ranked wallets differ from public API');
    for (const [index, row] of board.rows.entries()) {
      const profile = await getPublic(`/api/v1/consumer/profiles/${encodeURIComponent(row.actorId)}`);
      const expectedActions = profile.data.actions.filter(action => action.source.mode === 'LIVE' && action.actorId === row.actorId && ['CALL_OPEN', 'CALL_CLOSE'].includes(action.kind));
      const shown = await visit(`/u/${encodeURIComponent(row.actorId)}`, viewport, `wallet-${index}`, state => state.text.includes(shortActor(row.actorId)) && state.text.includes('Devnet records'));
      shown.check(shown.probe.activities === expectedActions.length, `activity count differs from public profile: ${shown.probe.activities}/${expectedActions.length}`);
    }
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
