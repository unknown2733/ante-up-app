/** Read-only browser check of the isolated Demo preview. No wallet page is loaded. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startPreviewServer } from './serve-preview.mjs';

const stageArg = process.argv[2];
if (!stageArg) throw new Error('Usage: node visual-check.mjs STAGE_DIRECTORY');
const stage = path.resolve(stageArg);
const dist = path.resolve(stage, 'dist');
const port = 4182;
const server = await startPreviewServer(dist, port);
const browserPath = process.env.ANTE_UP_CHROMIUM ?? path.join(process.env.USERPROFILE ?? homedir(), 'AppData', 'Local',
  'ms-playwright', 'chromium-1243', 'chrome-win64', 'chrome.exe');
const profileDir = path.join(stage, 'chrome-profile');
await mkdir(profileDir, { recursive: true });
const chrome = spawn(browserPath, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let browserError = '';
chrome.on('error', error => { browserError = error.message; });
chrome.stderr.on('data', chunk => { browserError = (browserError + chunk.toString()).slice(-2000); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
const findings = [];
try {
  let activePort;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { activePort = (await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; break; }
    catch { await delay(100); }
  }
  if (!activePort) throw new Error(`Chromium DevTools endpoint unavailable (exit=${chrome.exitCode}): ${browserError}`);
  const tabs = await (await fetch(`http://127.0.0.1:${activePort}/json/list`)).json();
  const tab = tabs.find(item => item.type === 'page');
  if (!tab) throw new Error('No browser page target');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) { const { resolve, reject } = pending.get(data.id); pending.delete(data.id); data.error ? reject(new Error(data.error.message)) : resolve(data.result); }
    if (data.method === 'Runtime.exceptionThrown') findings.push({ type: 'exception', text: data.params.exceptionDetails.text });
    if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') findings.push({ type: 'console-error', text: data.params.entry.text });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 10_000);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  const probe = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser-probe.js'), 'utf8');
  const results = [];
  for (const [name, width, height, mobile] of [['desktop',1440,900,false],['mobile',390,844,true]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await delay(900);
    for (const [view, click] of [['discovery', null],['chart', `document.querySelector('.au-market-row')?.click()`],
      ['leaderboard', `[...document.querySelectorAll('.au-primary-nav button')].find(b=>b.textContent.includes('Leaderboard'))?.click()`],
      ['profile', `document.querySelector('.au-social-actor')?.click()`]]) {
      if (click) { await send('Runtime.evaluate', { expression: click }); await delay(500); }
      const checked = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
      const metrics = checked.result.value;
      const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const image = path.join(stage, `${name}-${view}.png`);
      await writeFile(image, Buffer.from(screenshot.data, 'base64'));
      results.push({ name, view, image, metrics });
      if (metrics.horizontalOverflowPx > 0) findings.push({ type: 'overflow', name, view, pixels: metrics.horizontalOverflowPx });
      if (metrics.brokenImages.length) findings.push({ type: 'broken-image', name, view, urls: metrics.brokenImages });
      if (metrics.documentLanguage !== 'en') findings.push({ type: 'language', name, view, value: metrics.documentLanguage });
      if (mobile && metrics.smallTouchTargets.length) findings.push({ type: 'small-touch-target', name, view, targets: metrics.smallTouchTargets });
      if (view === 'chart') {
        const marker = await send('Runtime.evaluate', { expression: `(() => { const r=document.querySelector('.au-chart-marker')?.getBoundingClientRect(); return r ? {x:r.x+r.width/2,y:r.y+r.height/2}:null })()`, returnByValue: true });
        const point = marker.result.value;
        if (!point) findings.push({ type: 'marker-missing', name });
        else {
          if (mobile) {
            await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
            await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          } else {
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
          }
          await delay(200);
          const detail = await send('Runtime.evaluate', { expression: `!!document.querySelector('.au-chart-detail')`, returnByValue: true });
          if (!detail.result.value) findings.push({ type: 'marker-not-selectable', name });
          else {
            const selectedImage = path.join(stage, `${name}-marker.png`);
            const selected = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            await writeFile(selectedImage, Buffer.from(selected.data, 'base64'));
            results.push({ name, view: 'marker', image: selectedImage, metrics: { selected: true } });
          }
        }
      }
    }
  }
  await writeFile(path.join(stage, 'visual-report.json'), JSON.stringify({ results, findings }, null, 2));
  console.log(JSON.stringify({ report: path.join(stage, 'visual-report.json'), screenshots: results.map(item => item.image), findings }, null, 2));
  if (findings.length) process.exitCode = 1;
} finally {
  socket?.close();
  chrome.kill();
  server.close();
}
