import {readFile} from 'node:fs/promises';
const role=process.argv[2];
try {
 if(role==='api'||role==='web') {
  const url=role==='api'?'http://127.0.0.1:8787/v1/markets':'http://127.0.0.1:8080/';
  const response=await fetch(url,{signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error();
  if(role==='api'&&(await response.json()).mode!=='devnet')throw Error();
 }else{
  const s=JSON.parse(await readFile(`${process.env.ANTE_UP_HEALTH_DIRECTORY}/${role}.json`));
  if(Date.now()-s.at>(role==='indexer'?90000:180000))throw Error();
  if(role==='evidence'&&s.admissionGuard==='UNSAFE')throw Error();
  // An intentionally paused collector is alive; freshness remains a separate
  // admission/monitor gate. Unknown states must not conceal a dead source loop.
  const controlledWait=s.role===role&&s.state==='WAITING'&&
    ['STATE_STORAGE_LIMIT','HOST_STORAGE_LOW','PUBLICATION_PENDING','RPC_RATE_LIMITED'].includes(s.reason);
  if(role.startsWith('collector')&&!controlledWait&&(!s.lastPollAt||Date.now()/1000-s.lastPollAt>900))throw Error();
 }
}catch{process.exitCode=1;}
