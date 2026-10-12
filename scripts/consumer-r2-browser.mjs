/** Read-only R2 browser smoke. Requires a root-owned local integrated server and catalog export. */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startR2ReadonlyServer } from './consumer-r2-serve.mjs';

const args = process.argv.slice(2);
const option = flag => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
const baseArg = option('--url');
const catalogFile = option('--catalog-json');
const distArg = option('--dist');
if ((!baseArg && !distArg) || !catalogFile)
  throw new Error('Usage: node scripts/consumer-r2-browser.mjs --dist DIST --catalog-json PATH --source-sha SHA');
const base = new URL(baseArg ?? 'http://127.0.0.1:4188');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname))
  throw new Error('R2 browser QA accepts only a local HTTP server.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(path.resolve(catalogFile), 'utf8'));
if (!Array.isArray(catalog)) throw new Error('Catalog must be ConsumerMarket[].');
const samples = catalog.filter(item => item.source?.mode === 'DEMO');
const live = catalog.filter(item => item.source?.mode === 'LIVE');
const smoke = args.includes('--smoke');
const allowImages = args.includes('--allow-catalog-images');
const mediaOnly = args.includes('--media-only');
if (mediaOnly && !allowImages) throw new Error('--media-only requires --allow-catalog-images.');
const allowedImageOrigins = allowImages ? [...new Set(samples.map(item => {
  try { const url = new URL(item.thumbnailUrl); return url.protocol === 'https:' ? url.origin : null; }
  catch { return null; }
}).filter(Boolean))] : [];
const localServer = distArg ? await startR2ReadonlyServer(path.resolve(distArg), Number(base.port || 80), allowedImageOrigins) : null;
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
const results = [], failures = [], blockedRequests = [], browserErrors = [], permittedImages = [];
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
      let externalImage = false;
      try { const target = new URL(request.url); externalImage = allowImages && request.method === 'GET' &&
        message.params.resourceType === 'Image' && target.protocol === 'https:' && allowedImageOrigins.includes(target.origin); }
      catch { /* reject malformed URL */ }
      const allowed = ['GET', 'HEAD'].includes(request.method) && request.url.startsWith(base.origin + '/') || externalImage;
      if (externalImage) permittedImages.push(request.url);
      if (!allowed) blockedRequests.push({ method: request.method, url: request.url });
      const headers = externalImage ? Object.entries(request.headers).filter(([name]) =>
        !/^(cookie|authorization|proxy-authorization)$/i.test(name)).map(([name, value]) => ({ name, value })) : undefined;
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        allowed ? { requestId, ...(headers ? { headers } : {}) } : { requestId, errorReason: 'BlockedByClient' })
        .catch(error => browserErrors.push(error.message));
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
    return { url:location.href, title:document.title, text, language:document.documentElement.lang,
      overflow:Math.max(0,document.documentElement.scrollWidth-document.documentElement.clientWidth),
      brokenImages:[...document.images].filter(e=>visible(e)&&e.complete&&e.naturalWidth===0).map(e=>e.src),
      images:[...document.images].filter(visible).map(e=>({src:e.currentSrc||e.src,alt:e.alt,complete:e.complete,naturalWidth:e.naturalWidth,naturalHeight:e.naturalHeight})),
      fallbackImages:[...document.querySelectorAll('[role="img"]')].filter(visible).map(e=>e.getAttribute('aria-label')||''),
      marketRows:[...document.querySelectorAll('.au-market-row')].filter(visible).length,
      unnamed:controls.filter(e=>!label(e)).map(e=>e.outerHTML.slice(0,100)),
      smallTargets:controls.filter(e=>{const r=e.getBoundingClientRect();return r.width<40||r.height<40}).map(e=>({label:label(e),width:Math.round(e.getBoundingClientRect().width),height:Math.round(e.getBoundingClientRect().height),
        inlineText:e.tagName==='A'&&!!e.closest('.au-docs-article p,.au-docs-article li')})),
      modeControls:[...document.querySelectorAll('.au-mode-switch,.au-mobile-mode-switch')].filter(visible).length +
        (controls.some(e=>e.tagName==='BUTTON'&&label(e).trim()==='Live')&&
         controls.some(e=>e.tagName==='BUTTON'&&label(e).trim()==='Demo')?1:0),
      enabledFinancial:controls.filter(e=>e.tagName==='BUTTON'&&!e.disabled&&/^(Place chip|Buy|Sell|Open Pro|Deposit liquidity)$/i.test(label(e))).map(label),
      docsLinks:[...document.querySelectorAll('a[href^="/docs/"]')].map(e=>e.getAttribute('href')) };
  })()`;
  async function visit(route, viewport, view, navigate = true) {
    if (navigate) await send('Page.navigate', { url: new URL(route, base).href });
    await delay(allowImages ? 1800 : 1000);
    if (mediaOnly && view === 'explore') {
      await evaluate(`(async () => {
        const origins = ${JSON.stringify(allowedImageOrigins)};
        const images = [...document.images].filter(img => { try { return origins.includes(new URL(img.src).origin) } catch { return false } });
        await Promise.race([Promise.all(images.map(img => img.complete ? Promise.resolve() :
          new Promise(resolve => { img.addEventListener('load', resolve, {once:true}); img.addEventListener('error', resolve, {once:true}); }))),
          new Promise(resolve => setTimeout(resolve, 12000))]);
        return images.length;
      })()`);
    }
    const probe = await evaluate(state);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const image = path.join(run, `${viewport.name}-${view}.png`);
    await writeFile(image, Buffer.from(shot.data, 'base64'));
    const result = { viewport: viewport.name, view, route, probe, image };
    results.push(result);
    if (!probe.url.startsWith(base.origin + '/')) throw new Error(`${viewport.name}/${view}: navigation failed (${probe.url})`);
    if (probe.language !== 'en') failures.push(`${viewport.name}/${view}: language ${probe.language}`);
    if (probe.overflow) failures.push(`${viewport.name}/${view}: overflow ${probe.overflow}px`);
    if (probe.brokenImages.length) failures.push(`${viewport.name}/${view}: broken images`);
    if (probe.unnamed.length) failures.push(`${viewport.name}/${view}: unnamed controls`);
    if (viewport.mobile && probe.smallTargets.some(target => !target.inlineText))
      failures.push(`${viewport.name}/${view}: small standalone touch targets`);
    if (probe.modeControls) failures.push(`${viewport.name}/${view}: global mode control`);
    if (/\bfree[ -]?calls?\b/i.test(probe.text)) failures.push(`${viewport.name}/${view}: customer Free Call copy`);
    return result;
  }
  const viewports = mediaOnly ? [{ name: 'mobile-390', width: 390, height: 844, mobile: true }] :
    [{ name: 'desktop-1440', width: 1440, height: 900, mobile: false },
    { name: 'mobile-390', width: 390, height: 844, mobile: true },
    { name: 'mobile-320', width: 320, height: 568, mobile: true }];
  for (const viewport of viewports) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height,
      deviceScaleFactor: 1, mobile: viewport.mobile });
    await send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile, maxTouchPoints: viewport.mobile ? 5 : 1 });
    const discovery = await visit('/markets', viewport, 'explore');
    if (mediaOnly) for (const market of samples) {
      const image = discovery.probe.images.find(item => item.src === market.thumbnailUrl);
      if (!image?.complete || !image.naturalWidth)
        failures.push(`${viewport.name}: Explore image incomplete after bounded wait ${market.id}`);
    }
    if (discovery.probe.marketRows < 16 && !smoke) failures.push(`${viewport.name}: only ${discovery.probe.marketRows} Explore market rows`);
    for (const market of smoke ? samples.slice(0, 1) : samples) {
      if (!discovery.probe.text.includes(market.title)) failures.push(`${viewport.name}: missing Explore title ${market.id}`);
      const detail = await visit(`/markets/${encodeURIComponent(market.id)}`, viewport, `sample-${samples.indexOf(market)}`);
      if (!detail.probe.text.includes(market.title)) failures.push(`${viewport.name}: detail title mismatch ${market.id}`);
      if (!/Sample history|Sample data/i.test(detail.probe.text)) failures.push(`${viewport.name}: sample provenance absent ${market.id}`);
      if (detail.probe.enabledFinancial.length) failures.push(`${viewport.name}: sample action enabled ${market.id}`);
      if (allowImages) {
        const shown = detail.probe.images.find(image => image.src === market.thumbnailUrl);
        if (!shown?.naturalWidth) failures.push(`${viewport.name}: official image not rendered ${market.id}`);
      }
    }
    if (mediaOnly) continue;
    const docs = await visit('/docs', viewport, 'docs');
    const unknownDoc = await visit('/docs/qa-unknown-slug', viewport, 'docs-unknown');
    if (!/Page not found/i.test(unknownDoc.probe.text))
      failures.push(`${viewport.name}: unknown Docs slug has no not-found state`);
    // Exercise the client route directly: malformed percent encoding is rejected at the QA HTTP boundary.
    await evaluate("history.pushState(null, '', '/docs/%E0%A4%A'); window.dispatchEvent(new PopStateEvent('popstate'))");
    const malformedDoc = await visit('/docs/%E0%A4%A', viewport, 'docs-malformed', false);
    if (!/Page not found/i.test(malformedDoc.probe.text))
      failures.push(`${viewport.name}: malformed Docs slug has no not-found state`);
    const docRoutes = [...new Set(docs.probe.docsLinks)].slice(0, smoke ? 1 : 20);
    if (!smoke && docRoutes.length < 7) failures.push(`${viewport.name}: fewer than 7 Docs topic links`);
    for (const [index, route] of docRoutes.entries()) {
      const page = await visit(route, viewport, `docs-${index}`);
      if (page.probe.text.length < 100 || /\bTODO\b|\bTBD\b|\blorem ipsum\b|\bcoming soon\b|\bplaceholder\b/i.test(page.probe.text))
        failures.push(`${viewport.name}: incomplete Docs topic ${route}`);
    }
    if (viewport.name === 'mobile-390' && samples[0]) {
      await visit(`/markets/${encodeURIComponent(samples[0].id)}`, viewport, 'journey-chart');
      const marker = await evaluate("(() => {const e=document.querySelector('.au-chart-marker');if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
      if (!marker) failures.push('journey: chart marker absent');
      else {
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: marker.x, y: marker.y }] });
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await visit('', viewport, 'journey-marker', false);
        const noteHref = await evaluate(`document.querySelector(".au-chart-detail a[href^='/u/'][href*='action=']")?.getAttribute('href')||null`);
        if (!noteHref) failures.push('journey: marker note/profile link absent');
        else {
          await visit(noteHref, viewport, 'journey-profile-note');
          const hasNote = await evaluate("!!document.querySelector('.au-selected-action .au-social-note')");
          if (!hasNote) failures.push('journey: selected profile note absent');
          const chartClicked = await evaluate("(() => {const e=document.querySelector('.au-selected-action button');if(!e)return false;e.click();return true})()");
          if (!chartClicked) failures.push('journey: profile chart-return button absent');
          else {
            const returned = await visit('', viewport, 'journey-chart-return', false);
            if (!returned.probe.url.includes('action=')) failures.push('journey: chart return lost action ID');
          }
        }
      }
      await visit('/markets', viewport, 'journey-before-docs');
      const docsClicked = await evaluate("(() => {const e=[...document.querySelectorAll('.au-bottom-nav button')].find(b=>b.textContent.trim().includes('Docs'));if(!e)return false;e.click();return true})()");
      if (!docsClicked) failures.push('journey: mobile Docs tab absent');
      else {
        const docsHome = await visit('', viewport, 'journey-docs-home', false);
        if (!new URL(docsHome.probe.url).pathname.endsWith('/docs')) failures.push('journey: Docs tab did not navigate');
        const startClicked = await evaluate(`(() => {const e=document.querySelector(".au-docs-card[href='/docs/start']");if(!e)return false;e.click();return true})()`);
        if (!startClicked) failures.push('journey: Docs start card absent');
        else {
          const start = await visit('', viewport, 'journey-docs-article', false);
          if (!new URL(start.probe.url).pathname.endsWith('/docs/start')) failures.push('journey: Docs article navigation failed');
          const internal = await evaluate(`(() => {const e=document.querySelector(".au-docs-rail a[href='/docs/chips']");if(!e)return false;e.click();return true})()`);
          if (!internal) failures.push('journey: Docs internal topic link absent');
          else {
            const topic = await visit('', viewport, 'journey-docs-internal', false);
            if (!new URL(topic.probe.url).pathname.endsWith('/docs/chips')) failures.push('journey: Docs internal topic navigation failed');
          }
        }
      }
    }
    if (viewport.name === 'desktop-1440') {
      await visit('/docs/start', viewport, 'journey-docs-toc-start');
      const tocClicked = await evaluate(`(() => {const e=document.querySelector(".au-docs-toc a[href^='#']");if(!e)return false;e.click();return true})()`);
      if (!tocClicked) failures.push('journey: desktop Docs table of contents absent');
      else {
        const toc = await visit('', viewport, 'journey-docs-toc-target', false);
        if (!new URL(toc.probe.url).hash) failures.push('journey: Docs table of contents did not update hash');
      }
    }
  }
  if (samples.length !== 15 || live.length < 1) failures.push(`catalog has ${samples.length} samples and ${live.length} live markets`);
  if (blockedRequests.length) failures.push(`${blockedRequests.length} writes or external requests attempted and blocked`);
  const unexpectedErrors = browserErrors.filter(error =>
    !(!allowImages && /Content Security Policy directive.*img-src/i.test(error)));
  if (unexpectedErrors.length) failures.push(`${unexpectedErrors.length} unexpected browser errors`);
  const report = { sourceSha: option('--source-sha') ?? null, baseUrl: base.origin, catalogFile, run, smoke, mediaOnly,
    allowedImageOrigins, permittedImages, sampleCount: samples.length, liveCount: live.length, results,
    blockedRequests, browserErrors, unexpectedErrors, failures,
    boundary: 'Local read-only browser. It does not prove real wallet, chain finality, media licensing or note-subject review.' };
  const output = path.join(run, 'report.json');
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, views: results.length, failureCount: failures.length,
    firstFailures: failures.slice(0, 30) }, null, 2));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  const output = path.join(run, 'report.json');
  await writeFile(output, JSON.stringify({ fatalError: error.message, results, blockedRequests, browserErrors }, null, 2));
  console.error(JSON.stringify({ output, fatalError: error.message, capturedViews: results.length }, null, 2));
  process.exitCode = 1;
} finally {
  socket?.close();
  chrome.kill();
  localServer?.close();
}
