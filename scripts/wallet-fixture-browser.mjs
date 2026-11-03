/** Real Chromium execution of production wallet modules with existing injected fixtures. */
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(path.join(root,'apps/web/package.json'));
const {build}=require('esbuild');
const runtime=path.join(root,'.runtime/wallet-browser');await mkdir(runtime,{recursive:true});
const run=await mkdtemp(path.join(runtime,'run-'));
await build({entryPoints:[path.join(root,'apps/web/qa/browser/wallet-entry.mjs')],bundle:true,format:'esm',platform:'browser',jsx:'automatic',target:'es2022',outfile:path.join(run,'wallet.js'),plugins:[{name:'fixture-runtime',setup(b){
  b.onResolve({filter:/^(\.\/api|\.\/walletSdk|@solana\/kit-plugin-wallet\/react)$/},({path:specifier,importer})=>importer.endsWith('Financial.tsx')?{path:path.join(root,'apps/web/qa/browser/panel-adapter.tsx')}:undefined);
  b.onResolve({filter:/^(node:test|node:assert\/strict|vite)$/},({path:specifier})=>({path:path.join(root,'apps/web/qa/browser',specifier==='vite'?'vite-adapter.mjs':specifier==='node:test'?'test-runtime.mjs':'assert-adapter.mjs'),namespace:'file'}));
}}]});
const html='<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Isolated wallet fixtures</title><h1>Wallet fixtures · no live network or wallet</h1><pre>Running</pre><script type="module" src="/wallet.js"></script>';
const server=createServer(async(req,res)=>{
  if(req.method!=='GET'||!['/','/wallet.js'].includes(req.url)){res.writeHead(403);res.end();return;}
  res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile(path.join(run,'wallet.js')));
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const executable=process.env.ANTE_UP_CHROMIUM;if(!executable)throw Error('Set ANTE_UP_CHROMIUM to installed Chrome/Edge');
const chrome=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--disable-extensions','--remote-debugging-port=0',`--user-data-dir=${path.join(run,'profile')}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));let socket;
try{
 let port;for(let i=0;i<80;i++){try{port=(await readFile(path.join(run,'profile/DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];break;}catch{await delay(100);}}
 if(!port)throw Error('Browser did not start');
 const tab=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');
 socket=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
 let id=0;const pending=new Map(),blocked=[];
 const send=(method,params={})=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('CDP timeout: '+method));},20000);pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params}));});
 socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}if(m.method==='Fetch.requestPaused'){const p=m.params,allowed=p.request.method==='GET'&&new URL(p.request.url).origin===origin;if(!allowed)blocked.push({method:p.request.method,url:p.request.url});void send(allowed?'Fetch.continueRequest':'Fetch.failRequest',allowed?{requestId:p.requestId}:{requestId:p.requestId,errorReason:'BlockedByClient'});}});
 await send('Page.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
 const outputs=[];
 for(const width of [1440,390,320]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});await send('Page.navigate',{url:origin+'/'});
  let state;for(let i=0;i<200;i++){await delay(100);const reply=await send('Runtime.evaluate',{expression:'window.__walletQA',returnByValue:true});state=reply.result?.value;if(state?.done)break;}
  if(!state?.done){await writeFile(path.join(run,'timeout.json'),JSON.stringify(state,null,2));throw Error('Wallet fixture run did not finish: '+state?.current+'; '+run);}
  const screenshot=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(run,`${width}.png`),Buffer.from(screenshot.data,'base64'));
  outputs.push({width,...state});
 }
 const report={kind:'REAL_CHROMIUM_FIXTURE',sourceSha:process.argv[2]??null,outputs,blocked,boundary:'Production modules, injected test-only wallets/API/clock; no user wallet, provider, real signature or live mutation.'};
 await writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({run,outputs:outputs.map(({width,passed,failed})=>({width,passed,failed})),blocked}));
 if(blocked.length||outputs.some(r=>r.failed))process.exitCode=1;
}finally{socket?.close();chrome.kill();server.closeAllConnections();server.close();}
