// Deduplicated Telegram alert for the weekly Devnet Keeper. No signer material is loaded.
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {deliverTelegram} from './ops/monitor.mjs';

const [mode,statePath,tokenPath,chatPath]=process.argv.slice(2);
if(!['failure','success'].includes(mode)||!statePath?.startsWith('/state/keeper-auto/')||!tokenPath||!chatPath)
 throw Error('WEEKLY_NOTIFY_ARGUMENTS_INVALID');
let previous;
try{previous=JSON.parse(await readFile(statePath,'utf8'));}
catch(error){if(error.code!=='ENOENT')throw error;previous={active:false,sentAt:0};}
if(typeof previous.active!=='boolean'||!Number.isSafeInteger(previous.sentAt))throw Error('WEEKLY_NOTIFY_STATE_INVALID');
const now=Math.floor(Date.now()/1000),failure=mode==='failure';
if(failure===previous.active&&(!failure||now-previous.sentAt<21_600))process.exit(0);
const event={at:new Date(now*1000).toISOString(),
 firing:failure?[{severity:'critical',code:'WEEKLY_KEEPER_BLOCKED',scope:'Devnet settlement',metrics:{action:'Review server weekly Keeper log; no retry of unknown signature'}}]:[],
 resolved:failure?[]:[{code:'WEEKLY_KEEPER_BLOCKED',scope:'Devnet settlement'}]};
await deliverTelegram(tokenPath,chatPath,event);
await mkdir(dirname(statePath),{recursive:true,mode:0o700});
const temporary=statePath+'.tmp-'+process.pid;
await writeFile(temporary,JSON.stringify({active:failure,sentAt:now})+'\n',{flag:'wx',mode:0o600});
await rename(temporary,statePath);
