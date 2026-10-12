// Read-only simulation of the QA open instruction; never broadcasts.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {replaceJournal} from './atomic-rename.mjs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import * as c from '../clients/chain/dist/index.js';
import {safeError} from './qa-finance-devnet.mjs';
const req=createRequire(new URL('../clients/chain/package.json',import.meta.url));
const kit=req('@solana/kit'),spl=req('@solana-program/token');
const json=v=>JSON.stringify(v,(_,v)=>typeof v==='bigint'?v.toString():v);
async function main(){
 const step=process.argv.includes('--close')?'close-1':'open-1';
 const dir=process.env.ANTE_UP_QA_STATE_DIR,endpoint=(await readFile(process.env.ANTE_UP_QA_RPC_FILE,'utf8')).trim();
 const rpc=kit.createSolanaRpc(endpoint),t=c.createKitChainTransport(endpoint),j=JSON.parse(await readFile(join(dir,'journal.json'),'utf8'));
 const user=await kit.createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(await readFile(join(dir,'qa-wallet.json'),'utf8'))));
 const core=(await c.readFinalizedConfig(t)).data,fc=(await c.readFinalizedFinanceConfig(t)).data,f=(await c.readFinalizedFinanceMarket(t,j.market)).data;
 const [market]=await c.findMarketPda({marketId:Uint8Array.from(Buffer.from(j.marketSeedHex,'hex'))});
 const m=(await c.readFinalizedMarket(t,Uint8Array.from(Buffer.from(j.marketSeedHex,'hex')))).data;
 const [paymentVault]=await c.findPaymentVaultPda({market}),[ownerPayment]=await spl.findAssociatedTokenPda({mint:fc.paymentMint,owner:user.address,tokenProgram:spl.TOKEN_PROGRAM_ADDRESS});
 const clock=await t.getFinalizedAccount(kit.address('SysvarC1ock11111111111111111111111111111111'));
 const chainTime=Buffer.from(clock.data).readBigInt64LE(32);
 console.log(json({wallTime:Math.floor(Date.now()/1000),chainTime,proReopenAt:f.proReopenAt,lpGeneration:f.lpGeneration,validityGeneration:m.validityGeneration,
  latestDataThrough:m.latestDataThrough,signatureStatus:await t.getSignatureStatus(j.steps[step].signature),blockHeight:await rpc.getBlockHeight({commitment:'finalized'}).send(),lastValidBlockHeight:j.steps[step].lastValidBlockHeight}));
 const [position]=await c.findPositionPda({market,owner:user.address,positionId:1n}),[settlement]=await c.findSettlementPda(market,f.currentCycle);
 const ix=step==='close-1'?await c.getCloseProInstructionAsync({market,position,settlement,owner:user,minReceipt:0n,
  expectedSequence:m.latestSequence,expectedConfigVersion:core.configVersion,expectedStateVersion:f.stateVersion,deadline:chainTime+25n}):await c.getOpenProInstructionAsync({market,paymentMint:fc.paymentMint,paymentVault,ownerPayment,protocolTreasury:fc.protocolTreasury,owner:user,
  positionId:1n,collateral:100000000n,leverageBps:50000n,direction:c.PositionDirection.Long,maxPayment:110000000n,
  expectedSequence:m.latestSequence,expectedConfigVersion:core.configVersion,expectedStateVersion:f.stateVersion,deadline:BigInt(Math.floor(Date.now()/1000)+30)});
 const life=await t.getLatestBlockhash();let msg=kit.setTransactionMessageFeePayerSigner(user,kit.createTransactionMessage({version:0}));
 msg=kit.setTransactionMessageLifetimeUsingBlockhash({...life,blockhash:kit.blockhash(life.blockhash)},msg);msg=kit.appendTransactionMessageInstruction(ix,msg);
 const tx=await kit.signTransactionMessageWithSigners(msg),wire=kit.getBase64Decoder().decode(kit.getTransactionEncoder().encode(tx));
 const result=await rpc.simulateTransaction(wire,{encoding:'base64',commitment:'confirmed',sigVerify:false,replaceRecentBlockhash:true}).send();
 console.log(json({err:result.value.err,logs:result.value.logs,unitsConsumed:result.value.unitsConsumed}));
 if(process.argv.includes('--reconcile-expired')){
  assert.equal(result.value.err,null);
  const attempt=j.steps[step],status=await t.getSignatureStatus(attempt.signature);
  const height=await rpc.getBlockHeight({commitment:'finalized'}).send();
  const account=await t.getFinalizedAccount(position);
  assert.equal(status,null);assert.ok(height>BigInt(attempt.lastValidBlockHeight));
  if(step==='open-1')assert.equal(account.exists,false);else assert.equal(c.decodeProPosition(account).data.state,c.PositionState.Open);
  j.expiredAttempts??=[];j.expiredAttempts.push({...attempt,name:step,reconciledAt:new Date().toISOString(),finalizedHeight:height.toString(),positionAbsent:!account.exists});
  delete j.steps[step];
  const path=join(dir,'journal.json'),tmp=path+'.tmp';await writeFile(tmp,json(j),{mode:0o600});await replaceJournal(tmp,path);
  console.log('EXPIRED_OPEN_RECONCILED_NO_CHAIN_WRITE');
 }
}
main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
