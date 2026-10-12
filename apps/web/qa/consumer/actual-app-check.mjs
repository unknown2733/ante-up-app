/** Built App browser QA against a same-origin read-only fixture API. No wallet clicks. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startReadonlyAppServer } from './serve-app.mjs';

const distArg = process.argv[2];
const buildSha = process.argv[3] ?? 'unknown-build';
const required = process.argv.includes('--require-consumer');
if (!distArg) throw new Error('Usage: node actual-app-check.mjs DIST_DIRECTORY BUILD_SHA [--require-consumer]');
const dist = path.resolve(distArg);
async function buildDigest(directory) {
  const hash = createHash('sha256');
  async function walk(folder) {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        hash.update(path.relative(directory, absolute).replaceAll('\\', '/'));
        hash.update(await readFile(absolute));
      }
    }
  }
  await walk(directory);
  return hash.digest('hex');
}
const distSha256 = await buildDigest(dist);
const qaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const runRoot = path.join(qaRoot, '.runtime', 'actual-app-qa');
await mkdir(runRoot, { recursive: true });
const run = await mkdtemp(path.join(runRoot, 'run-'));
const browserPath = process.env.ANTE_UP_CHROMIUM ?? path.join(process.env.USERPROFILE ?? homedir(), 'AppData', 'Local',
  'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
const port = 4182;
const server = await startReadonlyAppServer(dist, port);
const browser = spawn(browserPath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--remote-debugging-port=0', `--user-data-dir=${path.join(run, 'chrome-profile')}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let browserError = '';
browser.on('error', error => { browserError = error.message; });
browser.stderr.on('data', chunk => { browserError = (browserError + chunk.toString()).slice(-2000); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const consoleErrors = [];
const networkWrites = [];
const externalRequests = [];
let socket;
try {
  let activePort;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { activePort = (await readFile(path.join(run, 'chrome-profile', 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; break; }
    catch { await delay(100); }
  }
  if (!activePort) throw new Error(`Chromium endpoint unavailable: ${browserError}`);
  const targets = await (await fetch(`http://127.0.0.1:${activePort}/json/list`)).json();
  const tab = targets.find(item => item.type === 'page');
  if (!tab) throw new Error('No Chrome page target');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let serial = 0;
  const waiting = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const pending = waiting.get(message.id); waiting.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') consoleErrors.push(message.params.entry.text);
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params.request;
      if (!['GET', 'HEAD'].includes(request.method)) networkWrites.push({ method: request.method, url: request.url });
      if (!request.url.startsWith(`http://127.0.0.1:${port}/`) && !request.url.startsWith('data:') && !request.url.startsWith('blob:'))
        externalRequests.push(request.url);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
    const timeout = setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 10_000);
    timeout.unref();
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  const browserProbe = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser-probe.js'), 'utf8');
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const click = async selector => {
    const found = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return false; e.click(); return true })()`);
    if (found) await delay(450);
    return found;
  };
  const capture = async (device, view, expectedSelector = null, expectedText = null) => {
    const metrics = await evaluate(browserProbe);
    const present = expectedSelector ? await evaluate(`!!document.querySelector(${JSON.stringify(expectedSelector)})`) : true;
    const body = await evaluate("document.body?.innerText || ''");
    const screen = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const image = path.join(run, `${device}-${view}.png`);
    await writeFile(image, Buffer.from(screen.data, 'base64'));
    const result = { device, view, url: await evaluate('location.href'), present,
      expectedText, textMatched: expectedText ? body.includes(expectedText) : null,
      visibleTextLength: body.length, hasVisibleHangul: /[가-힣]/u.test(body), metrics, image };
    results.push(result);
    return result;
  };
  const visit = async pathname => { await send('Page.navigate', { url: `http://127.0.0.1:${port}${pathname}` }); await delay(850); };
  const visibleModeButton = mode => `(() => { const e=[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(mode)} && b.getBoundingClientRect().width && b.getBoundingClientRect().height); return e || null })()`;
  for (const [device, width, height, mobile] of [['desktop', 1440, 900, false], ['mobile', 390, 844, true]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
    for (const [view, route, expected, expectedText] of [['markets','/markets','.au-discovery','No markets'], ['legacy-market','/markets/fixture%3Asol','.au-action-tabs','No finalized price history'],
      ['legacy-pro','/markets/fixture%3Asol/pro','.au-action-tabs','Open Pro'], ['legacy-lp','/markets/fixture%3Asol/lp','.au-action-tabs','Deposit liquidity'],
      ['leaderboard','/leaderboard','.au-social','No valid closed calls'], ['faucet','/faucet',null,'Connect a Solana wallet'],
      ['activity','/me',null,'Wallet not connected'], ['registration','/register',null,'Register a keyword'],
      ['missing-market','/markets/qa-missing',null,'Market not found']]) {
      await visit(route);
      await capture(device, view, expected, expectedText);
    }
    await visit('/markets');
    const demoButton = await evaluate("!!" + visibleModeButton('Demo'));
    if (!demoButton) {
      results.push({ device, view: 'consumer-demo-flow', status: 'NOT_RUN', reason: 'Demo switch absent from this build' });
      continue;
    }
    await evaluate(visibleModeButton('Demo') + '.click()');
    await delay(650);
    await capture(device, 'demo-discovery', '.au-market-row');
    if (await click('.au-market-row')) {
      const chart = await capture(device, 'demo-chart', '.au-chart');
      const deepLink = new URL(chart.url).pathname + new URL(chart.url).search;
      await visit(deepLink);
      await capture(device, 'demo-chart-reload', '.au-chart');
      const marker = await evaluate("(() => { const e=document.querySelector('.au-chart-marker'); if(!e)return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 } })()");
      if (marker) {
        if (mobile) {
          await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: marker.x, y: marker.y }] });
          await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: marker.x, y: marker.y, button: 'left', clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: marker.x, y: marker.y, button: 'left', clickCount: 1 });
        }
        await delay(250);
        await capture(device, 'demo-marker', '.au-chart-detail');
        const actor = await evaluate("document.querySelector('.au-chart-detail .au-chart-action-links a[href^=\"/u/\"][href*=\"action=\"]')?.getAttribute('href') || null");
        if (actor) {
          await visit(actor);
          await capture(device, 'demo-profile-note', '.au-selected-action .au-social-note');
          if (await click('.au-selected-action button')) {
            const linkedChart = await capture(device, 'demo-chart-from-profile', '.au-selected-action');
            await visit(new URL(linkedChart.url).pathname + new URL(linkedChart.url).search);
            await capture(device, 'demo-chart-action-reload', '.au-selected-action');
          } else results.push({ device, view: 'demo-profile-to-chart', status: 'FAIL', reason: 'Chart link absent from selected profile action' });
        } else results.push({ device, view: 'demo-marker-to-profile', status: 'FAIL', reason: 'Action note link absent from marker detail' });
      } else results.push({ device, view: 'demo-marker', status: 'FAIL', reason: 'Chart marker absent' });
    } else results.push({ device, view: 'demo-market-navigation', status: 'FAIL', reason: 'Market row absent' });
    await visit('/leaderboard?mode=demo');
    await capture(device, 'demo-leaderboard', '.au-social');
    if (await click('.au-social-actor')) await capture(device, 'demo-rank-profile', '.au-social');
    else results.push({ device, view: 'demo-rank-profile', status: 'FAIL', reason: 'Leaderboard actor absent' });
    await visit('/markets?mode=demo');
    const liveButton = await evaluate("!!" + visibleModeButton('Live'));
    if (liveButton) {
      await evaluate(visibleModeButton('Live') + '.click()');
      await delay(450);
      await capture(device, 'live-empty', '.au-discovery');
      const liveRows = await evaluate("document.querySelectorAll('.au-market-row').length");
      if (liveRows !== 0) results.push({ device, view: 'live-mode-isolation', status: 'FAIL', reason: `${liveRows} market rows in empty Live QA source` });
    } else results.push({ device, view: 'live-mode-switch', status: 'FAIL', reason: 'Live switch absent' });
  }
  const failures = [];
  for (const result of results) {
    if (!result.metrics) continue;
    if (result.metrics.horizontalOverflowPx > 0) failures.push(`${result.device}/${result.view}: overflow ${result.metrics.horizontalOverflowPx}px`);
    if (result.metrics.brokenImages?.length) failures.push(`${result.device}/${result.view}: broken images`);
    if (result.metrics.documentLanguage !== 'en') failures.push(`${result.device}/${result.view}: lang=${result.metrics.documentLanguage}`);
    if (result.hasVisibleHangul) failures.push(`${result.device}/${result.view}: visible Hangul`);
    if (result.visibleTextLength < 10) failures.push(`${result.device}/${result.view}: nearly blank page`);
    if (!result.metrics.iconHref) failures.push(`${result.device}/${result.view}: missing favicon link`);
    if (!result.metrics.title || !result.metrics.description) failures.push(`${result.device}/${result.view}: missing title or description`);
    if (result.metrics.unnamedControls?.length) failures.push(`${result.device}/${result.view}: unnamed controls`);
    if (result.device === 'mobile' && result.metrics.smallTouchTargets?.length) failures.push(`${result.device}/${result.view}: small touch targets`);
    if (required && result.present === false) failures.push(`${result.device}/${result.view}: expected component absent`);
    if (required && result.textMatched === false) failures.push(`${result.device}/${result.view}: missing text ${JSON.stringify(result.expectedText)}`);
  }
  if (consoleErrors.length) failures.push(`${consoleErrors.length} browser errors`);
  if (networkWrites.length) failures.push(`${networkWrites.length} attempted writes`);
  if (externalRequests.length) failures.push(`${externalRequests.length} external requests`);
  if (required && results.some(result => result.status === 'NOT_RUN')) failures.push('Consumer Demo flow absent');
  for (const result of results.filter(result => result.status === 'FAIL')) failures.push(`${result.device}/${result.view}: ${result.reason}`);
  const iconHref = results.find(result => result.metrics?.iconHref)?.metrics.iconHref;
  const iconResponseStatus = iconHref?.startsWith(`http://127.0.0.1:${port}/`) ? (await fetch(iconHref)).status : null;
  if (iconHref && iconResponseStatus !== 200) failures.push(`favicon request status ${iconResponseStatus ?? 'external or unavailable'}`);
  const report = { claimedSourceSha: buildSha, distSha256, sourceBuildMappingVerified: false,
    mock: 'read-only fixture plus Demo DTOs; empty Live list and QA-only legacy shell, no Live observations/actions', dist,
    results, iconResponseStatus, consoleErrors, networkWrites, externalRequests, failures };
  const reportPath = path.join(run, 'actual-app-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: reportPath, run, checks: results.map(result => ({
    device: result.device, view: result.view, present: result.present ?? null, status: result.status ?? null })),
    failures }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  socket?.close();
  browser.kill();
  server.close();
}
