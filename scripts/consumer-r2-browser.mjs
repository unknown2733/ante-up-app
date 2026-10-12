/** Read-only R2 browser smoke. Requires a root-owned local integrated server and catalog export. */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = flag => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
const baseArg = option('--url');
const catalogFile = option('--catalog-json');
if (!baseArg || !catalogFile) throw new Error('Usage: node scripts/consumer-r2-browser.mjs --url http://127.0.0.1:PORT --catalog-json PATH --source-sha SHA');
const base = new URL(baseArg);
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname))
  throw new Error('R2 browser QA accepts only a local HTTP server.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(path.resolve(catalogFile), 'utf8'));
if (!Array.isArray(catalog)) throw new Error('Catalog must be ConsumerMarket[].');
const samples = catalog.filter(item => item.source?.mode === 'DEMO');
const live = catalog.filter(item => item.source?.mode === 'LIVE');
const smoke = args.includes('--smoke');
const runRoot = path.join(root, '.runtime/consumer-r2-qa');
await mkdir(runRoot, { recursive: true });
const run = await mkdtemp(path.join(runRoot, 'browser-'));
const chromePath = process.env.ANTE_UP_CHROMIUM ?? path.join(process.env.USERPROFILE ?? homedir(),
  'AppData', 'Local', 'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${path.join(run, 'chrome-profile')}`, 'about:blank'],
{ stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let chromeError = '';
chrome.on('error', error => { chromeError = error.message; });
chrome.stderr.on('data', data => { chromeError = (chromeError + data.toString()).slice(-2000); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [], failures = [], blockedRequests = [], browserErrors = [];
let socket;
try {
  let debugPort;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { debugPort = (await readFile(path.join(run, 'chrome-profile/DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; break; }
    catch { await delay(100); }
  }
  if (!debugPort) throw new Error(`Chromium unavailable: ${chromeError}`);
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const tab = targets.find(target => target.type === 'page');
  if (!tab) throw new Error('No Chromium page target.');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let serial = 0;
  const waiting = new Map();
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      waiting.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      const timer = setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 15_000);
      timer.unref();
    });
  }
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const pending = waiting.get(message.id); waiting.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails.text);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') browserErrors.push(message.params.entry.text);
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      const allowed = ['GET', 'HEAD'].includes(request.method) && request.url.startsWith(base.origin + '/');
      if (!allowed) blockedRequests.push({ method: request.method, url: request.url });
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(error => browserErrors.push(error.message));
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  const evaluate = async expression => {
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text);
    return reply.result.value;
  };
  const state = `(() => {
    const visible = e => { const r=e.getBoundingClientRect(),s=getComputedStyle(e); return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'; };
    const controls=[...document.querySelectorAll('button,a,input,select,textarea')].filter(visible);
    const label=e=>e.getAttribute('aria-label')||e.textContent?.trim()||e.getAttribute('placeholder')||'';
    const text=document.body?.innerText||'';
    return { url:location.href, text, language:document.documentElement.lang,
      overflow:Math.max(0,document.documentElement.scrollWidth-document.documentElement.clientWidth),
      brokenImages:[...document.images].filter(e=>visible(e)&&e.complete&&e.naturalWidth===0).map(e=>e.src),
      unnamed:controls.filter(e=>!label(e)).map(e=>e.outerHTML.slice(0,100)),
      smallTargets:controls.filter(e=>{const r=e.getBoundingClientRect();return r.width<40||r.height<40}).map(e=>({label:label(e),width:Math.round(e.getBoundingClientRect().width),height:Math.round(e.getBoundingClientRect().height)})),
      modeControls:[...document.querySelectorAll('.au-mode-switch,.au-mobile-mode-switch')].filter(visible).length +
        (controls.some(e=>e.tagName==='BUTTON'&&label(e).trim()==='Live')&&
         controls.some(e=>e.tagName==='BUTTON'&&label(e).trim()==='Demo')?1:0),
      enabledFinancial:controls.filter(e=>e.tagName==='BUTTON'&&!e.disabled&&/^(Place chip|Buy|Sell|Open Pro|Deposit liquidity)$/i.test(label(e))).map(label),
      docsLinks:[...document.querySelectorAll('a[href^="/docs/"]')].map(e=>e.getAttribute('href')) };
  })()`;
  async function visit(route, viewport, view) {
    await send('Page.navigate', { url: new URL(route, base).href });
    await delay(1000);
    const probe = await evaluate(state);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const image = path.join(run, `${viewport.name}-${view}.png`);
    await writeFile(image, Buffer.from(shot.data, 'base64'));
    const result = { viewport: viewport.name, view, route, probe, image };
    results.push(result);
    if (probe.language !== 'en') failures.push(`${viewport.name}/${view}: language ${probe.language}`);
    if (probe.overflow) failures.push(`${viewport.name}/${view}: overflow ${probe.overflow}px`);
    if (probe.brokenImages.length) failures.push(`${viewport.name}/${view}: broken images`);
    if (probe.unnamed.length) failures.push(`${viewport.name}/${view}: unnamed controls`);
    if (viewport.mobile && probe.smallTargets.length) failures.push(`${viewport.name}/${view}: small touch targets`);
    if (probe.modeControls) failures.push(`${viewport.name}/${view}: global mode control`);
    if (/\bfree[ -]?calls?\b/i.test(probe.text)) failures.push(`${viewport.name}/${view}: customer Free Call copy`);
    return result;
  }
  const viewports = [{ name: 'desktop-1440', width: 1440, height: 900, mobile: false },
    { name: 'mobile-390', width: 390, height: 844, mobile: true },
    { name: 'mobile-320', width: 320, height: 568, mobile: true }];
  for (const viewport of viewports) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height,
      deviceScaleFactor: 1, mobile: viewport.mobile });
    await send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile, maxTouchPoints: viewport.mobile ? 5 : 1 });
    const discovery = await visit('/markets', viewport, 'explore');
    for (const market of smoke ? samples.slice(0, 1) : samples) {
      if (!discovery.probe.text.includes(market.title)) failures.push(`${viewport.name}: missing Explore title ${market.id}`);
      const detail = await visit(`/markets/${encodeURIComponent(market.id)}`, viewport, `sample-${samples.indexOf(market)}`);
      if (!detail.probe.text.includes(market.title)) failures.push(`${viewport.name}: detail title mismatch ${market.id}`);
      if (!/Sample history|Sample data/i.test(detail.probe.text)) failures.push(`${viewport.name}: sample provenance absent ${market.id}`);
      if (detail.probe.enabledFinancial.length) failures.push(`${viewport.name}: sample action enabled ${market.id}`);
    }
    const docs = await visit('/docs', viewport, 'docs');
    const docRoutes = [...new Set(docs.probe.docsLinks)].slice(0, smoke ? 1 : 20);
    if (!smoke && docRoutes.length < 7) failures.push(`${viewport.name}: fewer than 7 Docs topic links`);
    for (const [index, route] of docRoutes.entries()) {
      const page = await visit(route, viewport, `docs-${index}`);
      if (page.probe.text.length < 100 || /\bTODO\b|\bTBD\b|\blorem ipsum\b|\bcoming soon\b|\bplaceholder\b/i.test(page.probe.text))
        failures.push(`${viewport.name}: incomplete Docs topic ${route}`);
    }
  }
  if (samples.length !== 15 || live.length < 1) failures.push(`catalog has ${samples.length} samples and ${live.length} live markets`);
  if (blockedRequests.length) failures.push(`${blockedRequests.length} writes or external requests attempted and blocked`);
  if (browserErrors.length) failures.push(`${browserErrors.length} browser errors`);
  const report = { sourceSha: option('--source-sha') ?? null, baseUrl: base.origin, catalogFile, run, smoke,
    sampleCount: samples.length, liveCount: live.length, results, blockedRequests, browserErrors, failures,
    boundary: 'Local read-only browser. It does not prove real wallet, chain finality, media licensing or note-subject review.' };
  const output = path.join(run, 'report.json');
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, views: results.length, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  socket?.close();
  chrome.kill();
}
