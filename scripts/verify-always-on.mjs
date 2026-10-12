import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {FileCollectionState} from '../services/data/live.mjs';
import {FileCandidateRepository} from '../services/data/publisher.mjs';
import * as sdk from '../clients/chain/dist/index.js';
const kit=createRequire(new URL('../clients/chain/package.json',import.meta.url))('@solana/kit');
const check=(v,message)=>{if(!v)throw Error(message);};
try{
 const endpoint=(await readFile(process.env.ANTE_UP_RPC_URL_FILE,'utf8')).trim();
 const rpc=kit.createSolanaRpc(endpoint);
 check(await rpc.getGenesisHash().send()==='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG','DEVNET_REQUIRED');
 const config=JSON.parse(await readFile('/state/live-smoke/collection-config.json','utf8'));
 const state=await new FileCollectionState('/state/live-smoke/collection.json').read();
 const candidates=await new FileCandidateRepository('/state/live-smoke/candidates.json').read();
 const transport=sdk.createKitChainTransport(endpoint);
 const market=await sdk.readFinalizedMarket(transport,Buffer.from(config.seedHex,'hex'));
 const snapshot=await sdk.readFinalizedSnapshot(transport,market.address,market.data.latestSequence);
 const response=await fetch(process.env.ANTE_UP_VERIFY_API??'http://api:8787/v1/markets');
 const body=await response.json(),view=body.data?.find(x=>x.id===market.address);
 check(response.ok&&body.mode==='devnet'&&view?.snapshot?.payload.sequence===market.data.latestSequence.toString(),'API_SEQUENCE_MISMATCH');
 check(Buffer.from(snapshot.data.payloadHash).toString('hex')===view.snapshot.payloadHash,'API_HASH_MISMATCH');
 const age=Math.floor(Date.now()/1000)-Number(snapshot.data.dataThrough);
 check(age>=0&&age<600,'SNAPSHOT_STALE');
 const balance=await rpc.getBalance(kit.address('8qfbLii5YBfJiHoLGBNozyJnLFA4knBymTCtK9pP4mHH')).send();
 const rent=await rpc.getMinimumBalanceForRentExemption(BigInt((await transport.getFinalizedAccount(snapshot.address)).data.length)).send();
 const result={checkedAt:new Date().toISOString(),state:'VERIFIED',market:market.address,sequence:market.data.latestSequence.toString(),snapshot:snapshot.address,payloadHash:view.snapshot.payloadHash,dataThrough:Number(snapshot.data.dataThrough),ageSeconds:age,totalSpentMicros:state.totalSpentMicros,spentByDay:state.spentByDay,observationCount:state.markets[market.address].observations.length,pendingPublications:Object.values(candidates.jobs).filter(j=>j.state!=='FINALIZED').length,publisherLamports:balance.value.toString(),snapshotRentLamports:rent.toString(),apiMode:body.mode,publicFreeAdmission:view.capabilities.openFree.allowed};
 console.log(JSON.stringify(result));
 if(process.env.ANTE_UP_VERIFY_OUTPUT)await writeFile(process.env.ANTE_UP_VERIFY_OUTPUT,JSON.stringify(result,null,2)+'\n');
}catch(error){console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'ALWAYS_ON_VERIFY_FAILED');process.exitCode=1;}
