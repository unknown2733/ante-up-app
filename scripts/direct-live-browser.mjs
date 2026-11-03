/** One fresh browser tab, one live market, no API prefetch/replay or wallet. */
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const market=process.argv[2];if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(market??''))throw Error('Pass one public market PDA');
const root=fileURLToPath(new URL('../',import.meta.url));
await mkdir(path.join(root,'.runtime/direct-live'),{recursive:true});
const run=await mkdtemp(path.join(root,'.runtime/direct-live/run-'));
const chrome=spawn(process.env.ANTE_UP_CHROMIUM,['--headless=new','--disable-gpu','--no-first-run','--disable-extensions','--remote-debugging-port=0',`--user-data-dir=${path.join(run,'profile')}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));let socket;
try{
 let port;for(let i=0;i<80;i++){try{port=(await readFile(path.join(run,'profile/DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];break;}catch{await delay(100);}}
 if(!port)throw Error('Browser did not start');
 const tab=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');
 socket=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
 let id=0;const pending=new Map(),responses=[],blocked=[],states=[];
 const send=(method,params={})=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('CDP timeout: '+method));},20000);pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params}));});
 socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}
  if(m.method==='Network.responseReceived'){const r=m.params.response,u=new URL(r.url);if(u.origin==='https://ante-up.fun'&&u.pathname.startsWith('/api/'))responses.push({at:new Date().toISOString(),path:u.pathname+u.search,status:r.status,retryAfter:Object.entries(r.headers).find(([key])=>key.toLowerCase()==='retry-after')?.[1]??null});}
  if(m.method==='Fetch.requestPaused'){
    const p=m.params,u=new URL(p.request.url),allowed=['GET','HEAD'].includes(p.request.method)&&
      (u.origin==='https://ante-up.fun'||p.resourceType==='Image'&&['https://i.ytimg.com','https://i.scdn.co','https://pbs.twimg.com','https://images.unsplash.com'].includes(u.origin));
    if(!allowed)blocked.push({method:p.request.method,origin:u.origin});
    const headers=Object.entries(p.request.headers).filter(([key])=>!/^(cookie|authorization|proxy-authorization)$/i.test(key)).map(([name,value])=>({name,value}));
    void send(allowed?'Fetch.continueRequest':'Fetch.failRequest',allowed?{requestId:p.requestId,headers}:{requestId:p.requestId,errorReason:'BlockedByClient'});
  }
 });
 await send('Page.enable');await send('Network.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,mobile:false,deviceScaleFactor:1});
 await send('Page.navigate',{url:`https://ante-up.fun/markets/${market}/trade`});
 for(let i=0;i<16;i++){
  await delay(2000);
  const r=await send('Runtime.evaluate',{expression:"({text:document.body.innerText,ready:document.body.innerText.includes('Connect wallet to trade'),loading:document.body.innerText.includes('Loading markets'),syncing:document.body.innerText.includes('Syncing the latest observation')})",returnByValue:true});
  states.push({at:new Date().toISOString(),...r.result?.value});
 }
 const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(run,'market.png'),Buffer.from(shot.data,'base64'));
 const report={kind:'DIRECT_LIVE_SINGLE_TAB',market,run,responses,blocked,states,recovered:states.at(-1)?.ready===true,rateLimited:responses.some(r=>r.status===429)};
 await writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({run,responses,blocked,recovered:report.recovered,rateLimited:report.rateLimited}));
 if(!report.recovered||blocked.length)process.exitCode=1;
}finally{socket?.close();chrome.kill();}
