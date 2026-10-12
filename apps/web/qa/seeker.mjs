import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request, Agent } from 'node:http';

export const origin = 'https://ante-up.fun';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tools = resolve(root, '../../android-tools');
const adbPath = process.env.ANTE_UP_ADB || resolve(tools, 'platform-tools/adb.exe');
const port = '5038';

export function parseDevices(output) {
  return output.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('*') && !line.startsWith('List of devices'))
    .map(line => { const [serial, state, ...details] = line.split(/\s+/); return { serial, state, details: details.join(' ') }; });
}

export function selectDevice(devices, serial) {
  if (!serial && devices.length !== 1) throw new Error('Select one USB device with --serial; zero or multiple devices are attached.');
  const device = serial ? devices.find(device => device.serial === serial) : devices[0];
  if (!device || device.state !== 'device') throw new Error('Device is not authorized/online. Unlock it and accept USB debugging.');
  return device;
}

export function allowedUrl(value) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; } catch { return false; }
}

export function selectTarget(targets, id) {
  const matching = targets.filter(target => target.type === 'page' && allowedUrl(target.url));
  if (!id && matching.length !== 1) throw new Error('Open one Ante Up tab, or select its --target ID.');
  const target = id ? matching.find(target => target.id === id) : matching[0];
  if (!target || !/^ws:\/\/(localhost|127\.0\.0\.1):[0-9]+\/devtools\/page\/[^/?#]+$/.test(target.webSocketDebuggerUrl)) throw new Error('No allowed Ante Up page debugger.');
  return target;
}

function adb(args, serial) {
  const result = spawnSync(adbPath, ['-P', port, ...(serial ? ['-s', serial] : []), ...args], {
    env: { ...process.env, ANDROID_USER_HOME: resolve(tools, 'state') }, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || 'ADB failed.');
  return result.stdout.trim();
}

// ADB's loopback endpoint must never travel through an inherited HTTP proxy.
export function localTargets(localPort) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: localPort, path: '/json/list', agent: new Agent() }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('Open Chrome with Ante Up on the Seeker.')); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(new Error('Target list exceeds limit.')); });
      res.on('end', () => { try { const parsed = JSON.parse(body); if (!Array.isArray(parsed)) throw new Error(); resolve(parsed); } catch { reject(new Error('Invalid Chrome target list.')); } });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Chrome target connection timeout.')));
    req.on('error', reject); req.end();
  });
}

export async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connect timeout.')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP unavailable.')); }, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('CDP closed.')); }
    pending.clear();
  });
  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP command timeout.')); }, 5000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

// No application stores, auth tokens, wallet objects, network payloads or other tabs are read.
const visiblePage = `(() => {
  if (location.origin !== ${JSON.stringify(origin)} || document.visibilityState !== 'visible') throw Error('Ante Up must be the visible tab');
  return { url: location.href, title: document.title, width: innerWidth, height: innerHeight,
    pixelRatio: devicePixelRatio, documentWidth: document.documentElement.scrollWidth,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    appBundles: [...document.querySelectorAll('script[src]')].map(e => new URL(e.src)).filter(u => u.origin === location.origin && /^[/]assets[/]index-[a-zA-Z0-9_-]+[.]js$/.test(u.pathname)).map(u => u.pathname),
    financialTiming: performance.getEntriesByType('mark')
      .filter(e => /^ante-up[.]financial[.][0-9]+[.](quote[.](start|ready|failed)|prepare[.](start|ready)|verify[.](start|ready)|wallet[.](start|response|failed)|execute[.]failed)$/.test(e.name))
      .slice(-96).map(e => ({name:e.name, startTimeMs:Math.round(e.startTime),
        elapsedMs:Number.isFinite(e.detail?.elapsedMs) ? e.detail.elapsedMs : null,
        remainingSeconds:Number.isFinite(e.detail?.remainingSeconds) ? e.detail.remainingSeconds : null})),
    text: document.body.innerText.slice(0, 18000),
    controls: [...document.querySelectorAll('button,a,input,select')].filter(e => e.getClientRects().length).map(e => ({
      tag: e.tagName, label: (e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim(),
      type: e.getAttribute('type'), disabled: !!e.disabled,
      href: e.tagName === 'A' && e.href.startsWith(${JSON.stringify(origin)} + '/') ? e.href : null
    })) };
})()`;

export async function main(args = process.argv.slice(2)) {
  const [action = 'devices', ...rest] = args;
  if (!['devices', 'inspect', 'capture', 'click', 'fill', 'reload'].includes(action)) throw new Error('Actions: devices | inspect | capture | reload | click --label exact-visible-label | fill --label exact-placeholder --value decimal');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!['--serial', '--target', '--label', '--value'].includes(rest[index]) || !rest[index + 1]) throw new Error('Invalid arguments.');
    options[rest[index].slice(2)] = rest[index + 1];
  }
  await mkdir(resolve(tools, 'state'), { recursive: true });
  const devices = parseDevices(adb(['devices', '-l']));
  if (action === 'devices') { console.log(JSON.stringify({ adbPath, port, devices }, null, 2)); return; }
  const device = selectDevice(devices, options.serial);
  const localPort = adb(['forward', 'tcp:0', 'localabstract:chrome_devtools_remote'], device.serial);
  if (!/^\d+$/.test(localPort)) throw new Error('Invalid forwarded port.');
  let cdp;
  try {
    const targets = await localTargets(localPort);
    const matching = targets.filter(target => target.type === 'page' && allowedUrl(target.url));
    if (matching.length !== 1 && !options.target) {
      console.log(JSON.stringify({ anteUpTabs: matching.map(({ id, url }) => ({ id, url })) }, null, 2));
    }
    const target = selectTarget(targets, options.target);
    const wsUrl = new URL(target.webSocketDebuggerUrl); wsUrl.hostname = '127.0.0.1'; wsUrl.port = localPort;
    cdp = await connectCdp(wsUrl.href);
    const result = await cdp.call('Runtime.evaluate', { expression: visiblePage, returnByValue: true });
    if (result.exceptionDetails) throw new Error('Ante Up must be visible in Chrome. Wallet/private app inspection is not supported.');
    const state = result.result.value;
    if (action === 'inspect') console.log(JSON.stringify({ serial: device.serial, target: target.id, ...state }, null, 2));
    if (action === 'reload') { await cdp.call('Page.reload', { ignoreCache: true }); console.log(JSON.stringify({ reloaded: state.url })); }
    if (action === 'capture') {
      const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const directory = resolve(root, '.runtime/mobile-qa'); await mkdir(directory, { recursive: true });
      const path = resolve(directory, `seeker-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      await writeFile(path, Buffer.from(screenshot.data, 'base64'));
      console.log(JSON.stringify({ path, url: state.url }));
    }
    if (action === 'click') {
      if (!options.label) throw new Error('Provide --label matching exactly one visible enabled button/link.');
      const expression = `(() => {
        if (location.href !== ${JSON.stringify(state.url)} || document.visibilityState !== 'visible') throw Error('Page changed');
        const matches = [...document.querySelectorAll('button,a')].filter(e => e.getClientRects().length && !e.disabled &&
          (e.innerText || e.getAttribute('aria-label') || '').trim() === ${JSON.stringify(options.label)});
        if (matches.length !== 1) throw Error('Label is absent or ambiguous');
        const e = matches[0]; if (e.tagName === 'A' && new URL(e.href).origin !== ${JSON.stringify(origin)}) throw Error('External link blocked');
        e.click(); return { dispatched: true }; })()`;
      const clicked = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });
      if (clicked.exceptionDetails) throw new Error('Click blocked: page changed or label absent/ambiguous/external.');
      console.log(JSON.stringify({ ...clicked.result.value, note: 'A click is not transaction success. Wallet approvals remain manual; verify chain finality separately.' }));
    }
    if (action === 'fill') {
      if (!options.label || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(options.value ?? '')) throw new Error('Provide exact observed input label and a plain nonnegative decimal quantity (up to 6 decimals).');
      const expression = `(() => {
        if (location.href !== ${JSON.stringify(state.url)} || document.visibilityState !== 'visible') throw Error('Page changed');
        const matches = [...document.querySelectorAll('input')].filter(e => e.getClientRects().length && !e.disabled && !e.readOnly &&
          ['text','number'].includes(e.type) && (e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim() === ${JSON.stringify(options.label)});
        if (matches.length !== 1) throw Error('Input is absent or ambiguous');
        const e = matches[0]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(options.value)});
        e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('change', {bubbles:true}));
        return {filled:true,value:e.value}; })()`;
      const filled = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, userGesture: true });
      if (filled.exceptionDetails) throw new Error('Fill blocked: page changed or numeric input absent/ambiguous.');
      console.log(JSON.stringify(filled.result.value));
    }
  } finally {
    cdp?.close();
    adb(['forward', '--remove', `tcp:${localPort}`], device.serial);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
