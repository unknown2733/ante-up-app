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
  if(role==='collector'&&(!s.lastPollAt||Date.now()/1000-s.lastPollAt>900))throw Error();
 }
}catch{process.exitCode=1;}
