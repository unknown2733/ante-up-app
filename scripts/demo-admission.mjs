// One bounded Devnet demo session; no funding, cap changes, or transaction retries.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import * as c from '../clients/chain/dist/index.js';
import {safeError} from './qa-finance-devnet.mjs';
const require=createRequire(new URL('../clients/chain/package.json',import.meta.url));
const k=require('@solana/kit');
const encode=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v);
async function main(){
  const action=process.argv[2];assert.ok(['open','close','status'].includes(action));
  const endpoint=(await readFile('/run/secrets/rpc.url','utf8')).trim();
  const rpc=k.createSolanaRpc(endpoint),t=c.createKitChainTransport(endpoint);
  assert.equal(await rpc.getGenesisHash().send(),'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  const core=(await c.readFinalizedConfig(t)).data;
  const clock=await t.getFinalizedAccount(k.address('SysvarC1ock11111111111111111111111111111111'));
  const now=Buffer.from(clock.data).readBigInt64LE(32);
  let gate=(await c.readFinalizedAdmission(t)).data;
  if(action!=='status'){
    const dir='/state/financial-demo-20261013';await mkdir(dir,{recursive:true});
    const path=`${dir}/admission-${action}.json`;
    let saved;try{saved=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!saved){
      if(action==='open'){
        assert.equal(gate.open,false,'an existing open window must not be adopted');
        assert.ok(gate.outstanding<200,'global outstanding cap reached');
        assert.ok(gate.recent.filter(at=>at>0n&&now-at<86400n).length<100,'global daily cap reached');
        const market=c.getMarketDecoder().decode((await t.getFinalizedAccount(k.address('7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT'))).data);
        assert.equal(market.dataStatus,c.DataStatus.Valid,'real source must be valid before demo entry');
        assert.ok(now>=market.latestDataThrough&&now-market.latestDataThrough<600n,'real source stale');
      }
      const admin=await k.createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(await readFile('/run/secrets/admin.json','utf8'))));
      assert.equal(admin.address,core.admin);
      const ix=await c.getSetAdmissionGateInstructionAsync({admin,open:action==='open'});
      const life=await t.getLatestBlockhash();
      let message=k.setTransactionMessageFeePayerSigner(admin,k.createTransactionMessage({version:0}));
      message=k.setTransactionMessageLifetimeUsingBlockhash({...life,blockhash:k.blockhash(life.blockhash)},message);
      message=k.appendTransactionMessageInstruction(ix,message);
      const tx=await k.signTransactionMessageWithSigners(message);
      saved={action,signature:k.getSignatureFromTransaction(tx),lastValidBlockHeight:life.lastValidBlockHeight.toString(),state:'SIGNED',at:new Date().toISOString()};
      await writeFile(path,encode(saved),{flag:'wx',mode:0o600});
      // Unknown submission remains journalled; never replace it with a new transaction.
      await t.sendTransaction(k.getBase64Decoder().decode(k.getTransactionEncoder().encode(tx)));
    }
    let final=false;
    for(let i=0;i<40;i++){
      const status=await t.getSignatureStatus(saved.signature);assert.ok(!status?.err,'gate transaction failed');
      if(status?.confirmationStatus==='finalized'){final=true;break;}await delay(1000);
    }
    assert.ok(final,'gate transaction unknown; reconcile journal');
    saved.state='FINALIZED';await writeFile(path,encode(saved),{mode:0o600});
    gate=(await c.readFinalizedAdmission(t)).data;
    assert.equal(gate.open,action==='open','previous session finished; do not replay old gate journal');
    console.log(encode(saved));
  }
  console.log(encode({at:new Date().toISOString(),open:gate.open,outstanding:gate.outstanding,
    recent24h:gate.recent.filter(at=>at>0n&&now-at<86400n).length}));
}
main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
