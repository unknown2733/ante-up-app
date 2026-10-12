/** Production App regression using only public GETs and an isolated headless browser. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withVerifiedSubjectMedia } from '../apps/web/src/consumer-ui/catalog.ts';

const args = process.argv.slice(2);
const option = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
if (!option('--dist')) throw new Error('Usage: node scripts/result-card-browser.mjs --dist apps/web/dist [--api-origin https://ante-up.fun] [--source-sha SHA]');
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
const publicMarkets = await getPublic('/api/v1/consumer/markets');
const publicBoard = await getPublic('/api/v1/consumer/leaderboard?period=7D');
const catalog = publicMarkets.data.map(withVerifiedSubjectMedia);
const profiles = await Promise.all(publicBoard.data.rows.map(row => getPublic(`/api/v1/profiles/${encodeURIComponent(row.actorId)}`)));
const actualRecords = [...new Map(profiles.flatMap(page => [...page.data.openRecords, ...page.data.closedRecords]).map(record => [record.id, record])).values()];
const closed = actualRecords.filter(record => record.status === 'CLOSED_RESULT');
if (!closed.length) throw new Error('No real closed records available for share-card QA.');
const issuedRecord=(await getPublic('/api/v1/records/CjbpsPJJyqKBxoAmUcMTet5HNXz6hQxeeHquAN4afJTN')).data;
const issuedProof=(await getPublic(`/api/v1/proofs/${encodeURIComponent(issuedRecord.proofId)}`)).data;
if(issuedProof?.state!=='ISSUED'||issuedProof.recordId!==issuedRecord.id)throw new Error('Known public issued proof unavailable.');
const actualCases = [...new Map([issuedRecord, closed.find(record => Number(record.result?.numerator) < 0)].filter(Boolean).map(record=>[record.id,record])).values()];
const localCases = [
  { ...closed[0], id: 'qa-local:open-exclusion', status: 'OPEN', result: null, exit: null, proofId: null },
  { ...closed[0], id: 'qa-local:missing-performance', status: 'CLOSED_NA', result: { kind: 'na', reason: 'SOURCE_UNAVAILABLE' }, proofId: null },
  { ...issuedRecord,id:'qa-local:proof-pending',proofId:'qa-local:pending-proof' },
  { ...issuedRecord,id:'qa-local:proof-invalid',proofId:'qa-local:invalid-proof' },
];
const localProofs=[
  {...issuedProof,id:'qa-local:pending-proof',recordId:'qa-local:proof-pending',state:'CONFIRMING',sasId:null,confirmations:19},
  {...issuedProof,id:'qa-local:invalid-proof',recordId:'qa-local:proof-invalid',state:'INVALID',error:'CALCULATION_ERROR'},
];
const proofCases=[issuedProof,...localProofs];
const cases = [...actualCases, ...localCases];
const allowedImageOrigins = [...new Set(catalog.map(item => {
  try { const url = new URL(item.thumbnailUrl); return url.protocol === 'https:' ? url.origin : null; } catch { return null; }
}).filter(Boolean))];
const runRoot = path.join(root, '.runtime/result-card-qa');
await mkdir(runRoot, { recursive: true });
const run = await mkdtemp(path.join(runRoot, 'browser-'));
await writeFile(path.join(run, 'cases.json'), JSON.stringify({ actualCases, localCases, issuedProof, localProofs, note: 'Local cases are explicit QA-only response overrides, never public evidence.' }, null, 2));
await writeFile(path.join(run, 'catalog.json'), JSON.stringify(catalog, null, 2));
await readFile(path.join(dist, 'index.html'));
const results = [], failures = [], blockedRequests = [], browserErrors = [], publicReads = [];
const servedHistories = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  const send = (status, type, body) => { response.writeHead(status, {
    'content-type': type, 'cache-control': 'no-store',
    'content-security-policy': `default-src 'self' data: blob:; connect-src 'self'; img-src 'self' data: blob: ${allowedImageOrigins.join(' ')}; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:`,
  }); response.end(request.method === 'HEAD' ? null : body); };
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!['GET', 'HEAD'].includes(request.method)) { blockedRequests.push({ method: request.method, url: url.pathname }); send(405, 'text/plain', 'Read-only QA'); return; }
    if (url.pathname.startsWith('/api/')) {
      if (!url.pathname.startsWith('/api/v1/') || /\/auth(?:\/|$)/.test(url.pathname)) { send(403, 'text/plain', 'Public reads only'); return; }
      const localCase = localCases.find(record => url.pathname === `/api/v1/records/${encodeURIComponent(record.id)}`);
      if (localCase) { send(200, 'application/json', JSON.stringify({ schemaVersion: '0.1', mode: 'devnet', asOf: Math.floor(Date.now()/1000), nextCursor: null, data: localCase })); return; }
      const localProof = localProofs.find(proof => url.pathname === `/api/v1/proofs/${encodeURIComponent(proof.id)}`);
      if (localProof) { send(200, 'application/json', JSON.stringify({ schemaVersion: '0.1', mode: 'devnet', asOf: Math.floor(Date.now()/1000), nextCursor: null, data: localProof })); return; }
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
      const generatedImage = resourceType === 'Image' && target.protocol === 'blob:' && target.origin === base.origin;
      const allowed = ['GET', 'HEAD'].includes(request.method) && (target.origin === base.origin || externalImage || generatedImage);
      if (!allowed) blockedRequests.push({ method: request.method, url: request.url });
      const headers = Object.entries(request.headers).filter(([name]) => !/^(cookie|authorization|proxy-authorization)$/i.test(name)).map(([name, value]) => ({ name, value }));
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId, headers } : { requestId, errorReason: 'BlockedByClient' }).catch(error => browserErrors.push(error.message));
    }
  });
  for (const method of ['Page.enable', 'Runtime.enable', 'Log.enable']) await send(method);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  const evaluate = async expression => { const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text); return reply.result.value; };
  // Capture only this isolated page's requested copy value; never replace the user's clipboard.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__qaCopied=String(value)}}});Object.defineProperty(navigator,'canShare',{configurable:true,value:data=>!!data.files?.length});Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{window.__qaShared={title:data.title,text:data.text,files:await Promise.all(data.files.map(async f=>({name:f.name,type:f.type,size:f.size,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('')})))};if(window.__qaShareMode==='cancel')throw new DOMException('QA cancelled','AbortError');if(window.__qaShareMode==='fail')throw new Error('QA share failure');}});" });
  const probeCode = `(() => {
    const dialog=document.querySelector('.au-share-dialog'),preview=document.querySelector('.au-share-preview');
    const rect=dialog?.getBoundingClientRect();
    return {text:document.body.innerText,overflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),
      shareSection:!!document.querySelector('.au-result-share'),dialog:!!dialog?.open,
      bounds:rect?{left:rect.left,right:rect.right,width:rect.width,client:dialog.clientWidth,scroll:dialog.scrollWidth}:null,
      image:preview?{src:preview.src,complete:preview.complete,width:preview.naturalWidth,height:preview.naturalHeight,alt:preview.alt}:null,
      link:document.querySelector('.au-share-url')?.value,copied:window.__qaCopied,shared:window.__qaShared,
      feedback:document.querySelector('.au-share-feedback')?.textContent,
      actions:[...document.querySelectorAll('.au-share-actions button,.au-share-actions a')].map(e=>e.textContent.trim())};
  })()`;
  const waitFor = async predicate => {
    let probe;
    for(let i=0;i<80;i++){await delay(150);probe=await evaluate(probeCode);if(predicate(probe))return probe;}
    return probe;
  };
  const click = text => evaluate(`(() => {const e=[...document.querySelectorAll('button,a')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)return false;e.click();return true})()`);
  const screenshot = async name => {
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    const file=path.join(run,name+'.png');await writeFile(file,Buffer.from(shot.data,'base64'));return file;
  };
  const expectedResult = record => {
    if(record.status!=='CLOSED_RESULT'||record.result?.kind!=='return')return 'N/A';
    const value=Number(record.result.numerator)/Number(record.result.denominator)*100;
    const magnitude=Math.abs(value).toFixed(2);
    return `${Number(magnitude)===0?'':value<0?'−':'+'}${magnitude}%`;
  };
  const proofProbe=()=>evaluate(`(()=>({text:document.body.innerText,overflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),links:[...document.querySelectorAll('.au-proof-links a')].map(a=>({text:a.textContent,href:a.href})),panel:!!document.querySelector('.au-proof-links')}))()`);
  const checkProof=async(proof,name)=>{
    let state;
    for(let i=0;i<60;i++){await delay(100);state=await proofProbe();if(state.panel&&!state.text.includes('Checking proof status'))break;}
    const assert=(ok,message)=>{if(!ok)failures.push(`${name}: ${message}`);};
    assert(state.panel,'proof panel missing');
    const archive=state.links.filter(l=>l.href.startsWith('https://arweave.net/'));
    const sas=state.links.filter(l=>l.text.includes('SAS attestation'));
    assert(proof.state==='ISSUED'?archive.length===proof.evidence.length+1&&sas.length===1:archive.length===0&&sas.length===0,'issued/pending/invalid external proof links incorrect');
    if(proof.state==='ISSUED')await evaluate("document.querySelector('.au-proof-artifacts')?.setAttribute('open','')");
    state=await proofProbe();assert(state.overflow===0,`expanded proof overflow ${state.overflow}px`);
    return state;
  };
  for(const viewport of [{name:'desktop-1440',width:1440,height:900,mobile:false},{name:'mobile-390',width:390,height:844,mobile:true},{name:'mobile-320',width:320,height:568,mobile:true}]){
    await send('Emulation.setDeviceMetricsOverride',{...viewport,name:undefined,deviceScaleFactor:1});
    await send('Emulation.setTouchEmulationEnabled',{enabled:viewport.mobile,maxTouchPoints:viewport.mobile?5:1});
    for(const [index,record] of cases.entries()){
      const name=`${viewport.name}-${record.status.toLowerCase()}-${index}`;
      const check=(value,message)=>{if(!value)failures.push(`${name}: ${message}`)};
      await send('Page.navigate',{url:new URL(`/records/${encodeURIComponent(record.id)}`,base).href});
      let probe=await waitFor(state=>record.status==='OPEN'?state.text.includes('Active'):state.shareSection);
      check(probe.overflow===0,`record page overflow ${probe.overflow}px`);
      const recordProof=proofCases.find(p=>p.id===record.proofId);
      if(recordProof){const evidence=await checkProof(recordProof,name);await screenshot(`${name}-evidence`);check(evidence.panel,'record proof evidence absent');}
      if(record.status==='OPEN'){
        check(!probe.shareSection&&!probe.dialog,'open record offers a result card');
        results.push({name,recordId:record.id,localOverride:true,probe,image:await screenshot(name)});
        continue;
      }
      // Record, market and proof fetch independently; a provisional share section may disappear
      // while a later useData effect starts. Recheck after proof assertions before interacting.
      probe=await waitFor(state=>state.shareSection&&state.text.includes('Create result card'));
      check(probe.shareSection,'closed record share section absent');
      const created=await click('Create result card ↗');
      check(created,'create result card control absent');
      if(!created){results.push({name,recordId:record.id,probe,image:await screenshot(name)});continue;}
      probe=await waitFor(state=>state.dialog&&state.image?.complete&&state.image.width>0);
      check(probe.dialog&&probe.image?.width===1080&&probe.image.height===1080,'PNG preview did not render at1080×1080');
      check(probe.bounds?.left>=0&&probe.bounds.right<=viewport.width&&probe.bounds.scroll<=probe.bounds.client,'share dialog has horizontal overflow');
      check(probe.image?.alt.includes(expectedResult(record))&&probe.image.alt.includes('SOLANA DEVNET')&&probe.image.alt.includes('Not a cash return'),'preview misstates result/network/return meaning');
      const subject=catalog.find(market=>market.id===record.marketId||market.liveMarketId===record.marketId);
      if(subject)check(probe.image?.alt.startsWith(`${subject.title}:`),'preview uses an unresolved subject identity');
      if(record.status==='CLOSED_NA')check(probe.image?.alt.includes('N/A')&&!/\d+(?:\.\d+)?%/.test(probe.image?.alt??''),'missing performance fabricated a percentage');
      const expectedLink=`https://ante-up.fun/records/${encodeURIComponent(record.id)}`;
      check(probe.link===expectedLink,'public record link incorrect');
      check(await click('Copy record link'),'copy record link control absent');
      probe=await waitFor(state=>state.copied===expectedLink);
      check(probe.copied===expectedLink&&probe.feedback==='Record link copied.','clipboard handler did not receive exact public URL');
      const downloadDir=path.join(run,`${name}-download`);await mkdir(downloadDir);
      await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir,eventsEnabled:true});
      check(await click('Save PNG'),'Save PNG control absent');
      let files=[];
      for(let attempt=0;attempt<80;attempt++){files=(await readdir(downloadDir)).filter(file=>file.endsWith('.png'));if(files.length)break;await delay(150);}
      let download=null;
      if(files.length){
        const filename=path.join(downloadDir,files[0]),bytes=await readFile(filename);
        download={filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
        check(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&download.width===1080&&download.height===1080&&bytes.length>10000,'download is not a full1080×1080 PNG');
      }else check(false,'PNG file was not downloaded');
      let nativeShare=null;
      if(index===0){
        const attempts=[];
        for(const mode of ['success','cancel','fail']){
          await evaluate(`window.__qaShareMode=${JSON.stringify(mode)};window.__qaShared=null`);
          check(await click('Share image'),'native image share control absent with supported file API');
          const state=await waitFor(value=>!!value.shared&&(mode!=='fail'||value.feedback?.includes('Sharing did not complete')));
          check(state.shared?.files.length===1&&state.shared.files[0].type==='image/png'&&state.shared.files[0].size===download?.bytes&&state.shared.files[0].sha256===download?.sha256,'native share did not receive the same prepared PNG bytes');
          check(state.shared?.text.includes(expectedLink)&&state.shared.text.includes('Not a cash return'),'native share text omits result context or canonical record URL');
          check(mode==='fail'?state.feedback?.includes('Sharing did not complete'):state.feedback==='',`native ${mode} feedback is incorrect`);
          check(state.actions.includes('Save PNG')&&state.actions.includes('Copy record link'),'native share removed fallback controls');
          attempts.push({mode,shared:state.shared,feedback:state.feedback});
        }
        nativeShare=attempts;
        probe=await evaluate(probeCode);
      }
      results.push({name,recordId:record.id,localOverride:localCases.some(item=>item.id===record.id),probe,download,nativeShare,image:await screenshot(name)});
      check(await evaluate("(()=>{const e=document.querySelector('[aria-label=\"Close result card\"]');if(!e)return false;e.click();return true})()"),'dialog close control absent');
      check(!(await waitFor(state=>!state.dialog)).dialog,'dialog did not close');
    }
    for(const proof of proofCases){
      const name=`${viewport.name}-proof-${proof.state.toLowerCase()}`;
      await send('Page.navigate',{url:new URL(`/proofs/${encodeURIComponent(proof.id)}`,base).href});
      const probe=await checkProof(proof,name);
      results.push({name,proofId:proof.id,localOverride:localProofs.some(p=>p.id===proof.id),probe,image:await screenshot(name)});
      if(proof.state==='ISSUED'){
        await evaluate("document.querySelector('.au-proof-artifacts')?.scrollIntoView({block:'start'})");
        await delay(100);
        results[results.length-1].artifactImage=await screenshot(`${name}-artifacts`);
      }
    }
    console.log(JSON.stringify({viewport:viewport.name,cases:results.length,failures:failures.length}));
  }
  if(blockedRequests.length)failures.push(`${blockedRequests.length} disallowed requests attempted and blocked`);
  if(browserErrors.length)failures.push(`${browserErrors.length} browser errors`);
  const output=path.join(run,'report.json');
  const assets=[];for(const filename of (await readdir(path.join(dist,'assets'))).filter(name=>/\.(js|css)$/.test(name))){assets.push({file:filename,sha256:createHash('sha256').update(await readFile(path.join(dist,'assets',filename))).digest('hex')});}
  await writeFile(output,JSON.stringify({sourceSha:option('--source-sha'),assets,run,results,failures,browserErrors,blockedRequests,publicReads,
    boundary:'Actual closed records/issued proof use public GETs. OPEN, missing-result, pending and invalid proof variants are explicit localhost-only QA response overrides. Clipboard and native file sharing are mocked inside the isolated page. No user wallet/browser, writes, social posting or transaction.'},null,2));
  console.log(JSON.stringify({output,cases:results.length,failureCount:failures.length,failures},null,2));
  if(failures.length)process.exitCode=1;
}catch(error){
  const output=path.join(run,'report.json');await writeFile(output,JSON.stringify({fatalError:error.message,results,failures,browserErrors,blockedRequests,publicReads},null,2));
  console.error(JSON.stringify({output,fatalError:error.message}));process.exitCode=1;
}finally{socket?.close();chrome.kill();server.closeAllConnections();server.close();}
