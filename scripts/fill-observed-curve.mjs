/** Bounded operator-only Devnet curve fill for an independently observed market.
 * This records the signed transaction before submission and never resends an unknown signature.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as chain from '../clients/chain/dist/index.js';
import {UNIT,curveGross,tradeFee} from '../contracts/reference.mjs';
import {replaceJournal} from './atomic-rename.mjs';

const requireChain=createRequire(new URL('../clients/chain/package.json',import.meta.url));
const kit=requireChain('@solana/kit'),spl=requireChain('@solana-program/token');
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM=String(chain.ANTE_UP_PROGRAM_ADDRESS);
const QUANTITY=1_000n*UNIT;
const MAX_PAYMENT=1_102n*UNIT;
const MAX_CONTRIBUTION=10_000n*UNIT;
const safe=e=>String(e?.message??e).replace(/https?:\/\/[^\s"'<>]+/g,'[RPC_URL_REDACTED]').slice(0,300);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const output=value=>console.log(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,null,2));

export function fillQuote(sold,reserve,marketCount,supportSpent,supportBalance) {
  assert.equal(sold,0n,'CURVE_NOT_EMPTY');
  assert.equal(reserve,0n,'CURVE_RESERVE_NOT_EMPTY');
  assert.ok(marketCount<10,'SUPPORT_SLOTS_EXHAUSTED');
  assert.ok(supportSpent+MAX_CONTRIBUTION<=100_000n*UNIT,'SUPPORT_BUDGET_INSUFFICIENT');
  const gross=curveGross(sold,QUANTITY,'buy');
  const fee=tradeFee(gross).total;
  assert.ok(gross+fee<=MAX_PAYMENT,'CURVE_PRICE_EXCEEDS_MAX');
  assert.ok(supportBalance>=MAX_PAYMENT+MAX_CONTRIBUTION,'ACTUAL_SUPPORT_BALANCE_INSUFFICIENT');
  return {quantityAtoms:QUANTITY,grossAtoms:gross,feeAtoms:fee,maxPaymentAtoms:MAX_PAYMENT,
    supportBalanceAfterMaxPaymentAtoms:supportBalance-MAX_PAYMENT};
}

async function main(argv=process.argv,env=process.env){
  const mode=argv[2]??'--plan';
  assert.ok(['--plan','--execute','--status'].includes(mode),'MODE_INVALID');
  const market=env.ANTE_UP_FILL_MARKET_ID;
  const seedHex=env.ANTE_UP_FILL_MARKET_SEED_HEX;
  assert.ok(kit.isAddress(market)&&/^[0-9a-f]{64}$/.test(seedHex??''),'MARKET_IDENTITY_REQUIRED');
  assert.ok(env.ANTE_UP_FILL_RPC_FILE&&env.ANTE_UP_FILL_SOURCE_FILE,'INPUT_FILES_REQUIRED');
  const rpcUrl=(await readFile(env.ANTE_UP_FILL_RPC_FILE,'utf8')).trim();
  assert.ok(/^https:\/\//.test(rpcUrl),'RPC_URL_INVALID');
  const rpc=kit.createSolanaRpc(rpcUrl),transport=chain.createKitChainTransport(rpcUrl);
  assert.equal(await rpc.getGenesisHash().send(),GENESIS,'DEVNET_GENESIS_MISMATCH');
  const seed=Uint8Array.from(Buffer.from(seedHex,'hex'));
  const [derivedMarket]=await chain.findMarketPda({marketId:seed});
  assert.equal(String(derivedMarket),market,'MARKET_SEED_MISMATCH');
  const [m,f,fc,core]=await Promise.all([
    chain.readFinalizedMarket(transport,seed),
    chain.readFinalizedFinanceMarket(transport,market),
    chain.readFinalizedFinanceConfig(transport),
    chain.readFinalizedConfig(transport)
  ]);
  const marketData=m.data,finance=f.data,config=fc.data;
  const source=JSON.parse(await readFile(env.ANTE_UP_FILL_SOURCE_FILE,'utf8'));
  const queryHash=Buffer.from(marketData.queryHash).toString('hex');
  assert.ok(source.kind==='OBSERVED'&&source.cluster==='devnet'&&source.programId===PROGRAM&&
    source.marketId===market&&source.queryHash===queryHash&&source.source==='X_COUNTS'&&
    source.synthetic===false,'SOURCE_ATTESTATION_MISMATCH');
  const journalFile=env.ANTE_UP_FILL_JOURNAL_FILE;
  let journal=null;
  if(journalFile){
    try{journal=JSON.parse(await readFile(journalFile,'utf8'));}
    catch(e){if(e.code!=='ENOENT')throw e;}
    if(journal)assert.ok(journal.market===market&&journal.programId===PROGRAM&&
      journal.quantityAtoms===QUANTITY.toString()&&journal.wallet===String(config.admin),
      'JOURNAL_SCOPE_MISMATCH');
  }
  if(mode==='--status'){
    const status=journal?.signature?await transport.getSignatureStatus(journal.signature):null;
    output({market,phase:marketData.phase,curveSoldAtoms:finance.curveSold,
      curveReserveAtoms:finance.curveReserve,
      journal:journal?{state:journal.state,signature:journal.signature}:null,chainStatus:status});return;
  }
  assert.equal(marketData.phase,chain.MarketPhase.Curve,'NOT_CURVE');
  assert.equal(marketData.dataStatus,chain.DataStatus.Valid,'DATA_NOT_VALID');
  assert.equal(marketData.admission.state,chain.AdmissionState.Open,'ADMISSION_NOT_OPEN');
  const clock=await transport.getFinalizedAccount(kit.address('SysvarC1ock11111111111111111111111111111111'));
  assert.ok(clock.exists,'CLOCK_UNAVAILABLE');
  const chainTime=Buffer.from(clock.data).readBigInt64LE(32);
  assert.ok(marketData.latestDataThrough<=chainTime &&
    chainTime-marketData.latestDataThrough<600n,'DATA_STALE');
  assert.equal(String(config.admin),String(core.data.admin),'ADMIN_MISMATCH');
  const supportPayment=String(config.protocolTreasury);
  const supportAccount=await transport.getFinalizedAccount(kit.address(supportPayment));
  assert.ok(supportAccount.exists,'SUPPORT_ACCOUNT_MISSING');
  const support=spl.decodeToken(supportAccount).data;
  assert.equal(String(support.mint),String(config.paymentMint),'SUPPORT_MINT_MISMATCH');
  assert.equal(String(support.owner),String(config.admin),'SUPPORT_OWNER_MISMATCH');
  assert.ok(!journal,'EXISTING_JOURNAL_RECONCILE_FIRST');
  const quote=fillQuote(finance.curveSold,finance.curveReserve,config.supportedMarkets,
    config.supportSpent,support.amount);
  const plan={market,wallet:String(config.admin),programId:PROGRAM,sourceQueryHash:queryHash,
    snapshotSequence:marketData.latestSequence.toString(),stateVersion:finance.stateVersion.toString(),
    ...quote,execute:false};
  if(mode==='--plan'){output(plan);return;}
  assert.ok(journalFile&&env.ANTE_UP_FILL_ADMIN_KEYPAIR_FILE,'EXECUTE_INPUTS_REQUIRED');
  const signer=await kit.createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(
    await readFile(env.ANTE_UP_FILL_ADMIN_KEYPAIR_FILE,'utf8'))));
  assert.equal(String(signer.address),String(config.admin),'ADMIN_KEY_MISMATCH');
  const [keywordMint]=await chain.findKeywordMintPda({market:kit.address(market)});
  const [curveInventory]=await chain.findCurveInventoryPda({market:kit.address(market)});
  const [paymentVault]=await chain.findPaymentVaultPda({market:kit.address(market)});
  const [userKeyword]=await spl.findAssociatedTokenPda({mint:keywordMint,owner:signer.address,
    tokenProgram:spl.TOKEN_PROGRAM_ADDRESS});
  const instructions=[
    spl.getCreateAssociatedTokenIdempotentInstruction({payer:signer,ata:userKeyword,
      owner:signer.address,mint:keywordMint,tokenProgram:spl.TOKEN_PROGRAM_ADDRESS}),
    await chain.getCurveBuyInstructionAsync({market:kit.address(market),keywordMint,
      curveInventory,paymentVault,paymentMint:config.paymentMint,userKeyword,
      userPayment:config.protocolTreasury,protocolTreasury:config.protocolTreasury,user:signer,
      quantity:QUANTITY,maxPayment:MAX_PAYMENT,expectedSequence:0n,
      expectedConfigVersion:core.data.configVersion,expectedStateVersion:finance.stateVersion,
      deadline:chainTime+25n})
  ];
  let message=kit.setTransactionMessageFeePayerSigner(signer,kit.createTransactionMessage({version:0}));
  const lifetime=await transport.getLatestBlockhash();
  message=kit.setTransactionMessageLifetimeUsingBlockhash(
    {...lifetime,blockhash:kit.blockhash(lifetime.blockhash)},message);
  for(const instruction of instructions)message=kit.appendTransactionMessageInstruction(instruction,message);
  const signed=await kit.signTransactionMessageWithSigners(message);
  const signature=kit.getSignatureFromTransaction(signed);
  const wire=kit.getBase64Decoder().decode(kit.getTransactionEncoder().encode(signed));
  const simulation=await rpc.simulateTransaction(wire,{encoding:'base64',commitment:'processed',sigVerify:true}).send();
  assert.equal(simulation.value.err,null,'PRE_SEND_SIMULATION_FAILED');
  const intent={version:1,market,wallet:String(signer.address),programId:PROGRAM,
    quantityAtoms:QUANTITY.toString(),maxPaymentAtoms:MAX_PAYMENT.toString(),signature,
    state:'SIGNED',lastValidBlockHeight:lifetime.lastValidBlockHeight.toString()};
  const file=await open(journalFile,'wx',0o600);
  try{await file.writeFile(JSON.stringify(intent,null,2)+'\n');await file.sync();}
  finally{await file.close();}
  try{assert.equal(await transport.sendTransaction(wire),signature);}
  catch(e){output({state:'UNKNOWN',signature,error:safe(e)});process.exitCode=2;return;}
  for(let i=0;i<40;i++){
    const status=await transport.getSignatureStatus(signature);
    if(status?.err!=null){output({state:'FAILED',signature,error:status.err});process.exitCode=1;return;}
    if(status?.confirmationStatus==='finalized'){
      const next={...intent,state:'FINALIZED'};
      const tmp=journalFile+'.tmp';await writeFile(tmp,JSON.stringify(next,null,2)+'\n',{mode:0o600});
      await replaceJournal(tmp,journalFile);
      output({state:'FINALIZED',signature,market});return;
    }
    await sleep(1500);
  }
  output({state:'UNKNOWN',signature});process.exitCode=2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(e=>{console.error(safe(e));process.exitCode=1;});
