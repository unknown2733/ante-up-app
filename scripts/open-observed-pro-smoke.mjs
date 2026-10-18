/** Open one bounded Devnet Pro position on a verified observed market. Never auto-resends. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as chain from '../clients/chain/dist/index.js';
import {UNIT,freeCapital} from '../contracts/reference.mjs';
import {replaceJournal} from './atomic-rename.mjs';

const requireChain=createRequire(new URL('../clients/chain/package.json',import.meta.url));
const kit=requireChain('@solana/kit'),spl=requireChain('@solana-program/token');
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM=String(chain.ANTE_UP_PROGRAM_ADDRESS);
const COLLATERAL=10n*UNIT,MAX_PAYMENT=12n*UNIT,LEVERAGE_BPS=50_000n,POSITION_ID=1n;
const safe=e=>String(e?.message??e).replace(/https?:\/\/[^\s"'<>]+/g,'[RPC_URL_REDACTED]').slice(0,300);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const output=value=>console.log(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v));

async function main(argv=process.argv,env=process.env){
  const mode=argv[2]??'--plan';
  assert.ok(['--plan','--execute','--status'].includes(mode),'MODE_INVALID');
  const market=env.ANTE_UP_OBSERVED_PRO_MARKET_ID;
  const seedHex=env.ANTE_UP_OBSERVED_PRO_MARKET_SEED_HEX;
  assert.ok(kit.isAddress(market)&&/^[0-9a-f]{64}$/.test(seedHex??''),'MARKET_IDENTITY_REQUIRED');
  assert.ok(env.ANTE_UP_OBSERVED_PRO_RPC_FILE&&env.ANTE_UP_OBSERVED_PRO_SOURCE_FILE&&
    env.ANTE_UP_OBSERVED_PRO_TRADER_KEYPAIR_FILE,'INPUT_FILES_REQUIRED');
  const endpoint=(await readFile(env.ANTE_UP_OBSERVED_PRO_RPC_FILE,'utf8')).trim();
  assert.ok(/^https:\/\//.test(endpoint),'RPC_URL_INVALID');
  const rpc=kit.createSolanaRpc(endpoint),transport=chain.createKitChainTransport(endpoint);
  assert.equal(await rpc.getGenesisHash().send(),GENESIS,'DEVNET_GENESIS_MISMATCH');
  const seed=Uint8Array.from(Buffer.from(seedHex,'hex'));
  const [derivedMarket]=await chain.findMarketPda({marketId:seed});
  assert.equal(String(derivedMarket),market,'MARKET_SEED_MISMATCH');
  const signer=await kit.createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(
    await readFile(env.ANTE_UP_OBSERVED_PRO_TRADER_KEYPAIR_FILE,'utf8'))));
  const source=JSON.parse(await readFile(env.ANTE_UP_OBSERVED_PRO_SOURCE_FILE,'utf8'));
  const [marketAccount,financeAccount,configAccount,coreAccount]=await Promise.all([
    chain.readFinalizedMarket(transport,seed),chain.readFinalizedFinanceMarket(transport,market),
    chain.readFinalizedFinanceConfig(transport),chain.readFinalizedConfig(transport)]);
  const m=marketAccount.data,f=financeAccount.data,fc=configAccount.data,core=coreAccount.data;
  const queryHash=Buffer.from(m.queryHash).toString('hex');
  assert.ok(source.kind==='OBSERVED'&&source.cluster==='devnet'&&source.programId===PROGRAM&&
    source.marketId===market&&source.queryHash===queryHash&&source.source==='X_COUNTS'&&
    source.synthetic===false,'SOURCE_ATTESTATION_MISMATCH');
  const [position]=await chain.findPositionPda({market:kit.address(market),owner:signer.address,
    positionId:POSITION_ID});
  const journalFile=env.ANTE_UP_OBSERVED_PRO_JOURNAL_FILE;
  let journal=null;
  if(journalFile){try{journal=JSON.parse(await readFile(journalFile,'utf8'));}
    catch(e){if(e.code!=='ENOENT')throw e;}}
  if(journal)assert.ok(journal.market===market&&journal.wallet===String(signer.address)&&
    journal.positionId===POSITION_ID.toString(),'JOURNAL_SCOPE_MISMATCH');
  if(mode==='--status'){
    output({market,wallet:String(signer.address),position:String(position),
      currentCycle:f.currentCycle,openPositions:f.openPositions,
      journal:journal?{state:journal.state,signature:journal.signature}:null,
      chainStatus:journal?.signature?await transport.getSignatureStatus(journal.signature):null});return;
  }
  assert.ok(!journal,'EXISTING_JOURNAL_RECONCILE_FIRST');
  assert.equal(m.phase,chain.MarketPhase.Indexed,'NOT_INDEXED');
  assert.equal(m.dataStatus,chain.DataStatus.Valid,'DATA_NOT_VALID');
  assert.equal(m.admission.state,chain.AdmissionState.Open,'ADMISSION_NOT_OPEN');
  const clock=await transport.getFinalizedAccount(kit.address('SysvarC1ock11111111111111111111111111111111'));
  assert.ok(clock.exists,'CLOCK_UNAVAILABLE');
  const chainTime=Buffer.from(clock.data).readBigInt64LE(32);
  assert.ok(m.latestDataThrough<=chainTime&&chainTime-m.latestDataThrough<600n,'DATA_STALE');
  assert.ok(chainTime>=f.proReopenAt&&chainTime>=f.lpWindowEnd,'INITIAL_LP_WINDOW_ACTIVE');
  assert.ok(f.currentMaturity===0n&&f.openPositions===0,'TRIAL_REQUIRES_FIRST_CYCLE');
  assert.ok(!(await transport.getFinalizedAccount(position)).exists,'POSITION_ID_ALREADY_USED');
  const [ownerPayment]=await spl.findAssociatedTokenPda({mint:fc.paymentMint,owner:signer.address,
    tokenProgram:spl.TOKEN_PROGRAM_ADDRESS});
  const balanceAccount=await transport.getFinalizedAccount(ownerPayment);
  assert.ok(balanceAccount.exists,'TRADER_PAYMENT_ACCOUNT_MISSING');
  const balance=spl.decodeToken(balanceAccount).data.amount;
  assert.ok(balance>=MAX_PAYMENT,'TRADER_BALANCE_INSUFFICIENT');
  const vault=await transport.getFinalizedAccount(f.paymentVault);
  assert.ok(vault.exists,'PAYMENT_VAULT_MISSING');
  const assets=spl.decodeToken(vault).data.amount;
  const free=freeCapital(assets,f.externalQ,f.pmax,f.proReserved,f.otherReserved,500n*UNIT);
  assert.ok(free>=100n*UNIT,'VAULT_CAPITAL_TOO_LOW');
  const plan={market,wallet:String(signer.address),position:String(position),direction:'long',
    positionId:POSITION_ID,collateralAtoms:COLLATERAL,maxPaymentAtoms:MAX_PAYMENT,
    leverageBps:LEVERAGE_BPS,sourceQueryHash:queryHash,snapshotSequence:m.latestSequence,
    freeCapitalAtoms:free,cycleBefore:f.currentCycle,execute:false};
  if(mode==='--plan'){output(plan);return;}
  assert.ok(journalFile,'JOURNAL_REQUIRED');
  const instruction=await chain.getOpenProInstructionAsync({market:kit.address(market),
    paymentMint:fc.paymentMint,paymentVault:f.paymentVault,ownerPayment,
    protocolTreasury:fc.protocolTreasury,owner:signer,positionId:POSITION_ID,
    collateral:COLLATERAL,leverageBps:LEVERAGE_BPS,direction:chain.PositionDirection.Long,
    maxPayment:MAX_PAYMENT,expectedSequence:m.latestSequence,
    expectedConfigVersion:core.configVersion,expectedStateVersion:f.stateVersion,
    deadline:chainTime+25n});
  let message=kit.setTransactionMessageFeePayerSigner(signer,kit.createTransactionMessage({version:0}));
  const lifetime=await transport.getLatestBlockhash();
  message=kit.setTransactionMessageLifetimeUsingBlockhash(
    {...lifetime,blockhash:kit.blockhash(lifetime.blockhash)},message);
  message=kit.appendTransactionMessageInstruction(instruction,message);
  const signed=await kit.signTransactionMessageWithSigners(message);
  const signature=kit.getSignatureFromTransaction(signed);
  const wire=kit.getBase64Decoder().decode(kit.getTransactionEncoder().encode(signed));
  const simulation=await rpc.simulateTransaction(wire,{encoding:'base64',commitment:'processed',
    sigVerify:true}).send();
  assert.equal(simulation.value.err,null,'PRE_SEND_SIMULATION_FAILED');
  const intent={version:1,market,wallet:String(signer.address),positionId:POSITION_ID.toString(),
    signature,state:'SIGNED',lastValidBlockHeight:lifetime.lastValidBlockHeight.toString()};
  const file=await open(journalFile,'wx',0o600);
  try{await file.writeFile(JSON.stringify(intent,null,2)+'\n');await file.sync();}
  finally{await file.close();}
  try{assert.equal(await transport.sendTransaction(wire),signature);}
  catch(e){output({state:'UNKNOWN',signature,error:safe(e)});process.exitCode=2;return;}
  for(let i=0;i<40;i++){
    const status=await transport.getSignatureStatus(signature);
    if(status?.err!=null){output({state:'FAILED',signature,error:status.err});process.exitCode=1;return;}
    if(status?.confirmationStatus==='finalized'){
      const next={...intent,state:'FINALIZED'},tmp=journalFile+'.tmp';
      await writeFile(tmp,JSON.stringify(next,null,2)+'\n',{mode:0o600});
      await replaceJournal(tmp,journalFile);
      output({state:'FINALIZED',signature,market,position:String(position)});return;
    }
    await sleep(1500);
  }
  output({state:'UNKNOWN',signature});process.exitCode=2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(e=>{console.error(safe(e));process.exitCode=1;});
