import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export async function checkHttpHealth(role,fetchImpl=fetch) {
 if(role!=='api'&&role!=='web')throw Error('INVALID_HTTP_HEALTH_ROLE');
 const url=role==='api'?'http://127.0.0.1:8787/health':'http://127.0.0.1:8080/';
 const response=await fetchImpl(url,{signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Error('HTTP_HEALTH_FAILED');
 if(role==='api') {
  const body=await response.json();
  if(!body||body.service!=='ante-up-api'||body.kind!=='liveness'||body.status!=='ok'||
    body.mode!=='devnet'||body.cluster!=='devnet'||body.configurationReady!==true)
    throw Error('API_LIVENESS_INVALID');
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
const role=process.argv[2];
try {
 if(role==='api'||role==='web') {
  await checkHttpHealth(role);
 }else{
  const s=JSON.parse(await readFile(`${process.env.ANTE_UP_HEALTH_DIRECTORY}/${role}.json`));
  if(Date.now()-s.at>(role==='indexer'?90000:180000))throw Error();
  if(role==='evidence'&&s.admissionGuard==='UNSAFE')throw Error();
  // An intentionally paused collector is alive; freshness remains a separate
  // admission/monitor gate. Unknown states must not conceal a dead source loop.
  const controlledWait=Number.isSafeInteger(s.at)&&s.at<=Date.now()+30_000&&s.role===role&&s.state==='WAITING'&&
    ['STATE_STORAGE_LIMIT','HOST_STORAGE_LOW','PUBLICATION_PENDING','RPC_RATE_LIMITED'].includes(s.reason);
  if(role.startsWith('collector')&&!controlledWait&&(!s.lastPollAt||Date.now()/1000-s.lastPollAt>900))throw Error();
 }
}catch{process.exitCode=1;}
}
