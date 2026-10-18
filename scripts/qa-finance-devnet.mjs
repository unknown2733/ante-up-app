// Explicit synthetic Devnet financial QA. Trial markets are visibly labelled in the registry.
// No deployment, X request, admission change, private key output or automatic resend.
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,open,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as chain from '../clients/chain/dist/index.js';
import {UNIT,Q12,ceilDiv,indexPrice,freeCapital,pro,timeFee,tradeFee} from '../contracts/reference.mjs';
import {replaceJournal} from './atomic-rename.mjs';
import {hash as canonicalHash} from '../services/data/index.mjs';
const requireChain=createRequire(new URL('../clients/chain/package.json',import.meta.url));
const kit=requireChain('@solana/kit'),spl=requireChain('@solana-program/token'),system=requireChain('@solana-program/system');
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MINT='71sfbfYrJ9E417R57Ra2d5z1gp8xCbXJbgGTpT8bgLHe';
const ADMIN='5Fm81PP7TXvyNJHoB4DrwWETYdfqKtc45s6WRK8qdx5e';
const LABEL='ante-up-synthetic-finance-qa-20261013-v1';
export const DEMO_LABEL='ante-up-synthetic-finance-demo-20261013-v1';
export function runProfile(env) {
  const demo=env.ANTE_UP_QA_PROFILE==='demo';
  assert.ok(!env.ANTE_UP_QA_PROFILE||demo,'unsupported QA profile');
  return {demo,label:demo?DEMO_LABEL:LABEL,maxContribution:(demo?7200n:10000n)*UNIT};
}
const digest=value=>new Uint8Array(createHash('sha256').update(value).digest());
const json=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const safeError=e=>String(e?.message??'QA_ERROR').replace(/https?:\/\/[^\s"'<>]+/g,'[RPC_URL_REDACTED]').slice(0,500);

export function syntheticCandidate({market,sequence,queryHash,configVersion,computedAt,activity,label=LABEL}) {
  const evidence={source:'synthetic-financial-qa',notRealTrend:true,label,
    description:'Direct deterministic financial test inputs; not measured X activity or a replayed EWMA.',
    sequence:sequence.toString(),activityNowQ12:(activity*Q12).toString(),activity7dQ12:(100n*Q12).toString(),computedAt};
  const candidate={schemaVersion:'0.1',formulaVersion:'h3-d7-q12-v1',configVersion:configVersion.toString(),
    queryVersion:'1',queryHash:Buffer.from(queryHash).toString('hex'),marketId:market,sequence:sequence.toString(),
    dataThrough:computedAt-5,computedAt,activityNowQ12:evidence.activityNowQ12,activity7dQ12:evidence.activity7dQ12,
    dataStatus:'VALID',reason:null,admission:{state:'OPEN',recoveryCount:0,reason:null},evidenceHash:canonicalHash(evidence)};
  return {candidate,candidateHash:canonicalHash(candidate),syntheticEvidence:evidence};
}

export function auditFinance({finance:f,assets,price}) {
  const spotReserve=ceilDiv(f.externalQ*f.pmax,UNIT);
  const free=freeCapital(assets,f.externalQ,f.pmax,f.proReserved,f.otherReserved,500n*UNIT);
  assert.ok(f.totalShares>=f.lockedShares,'locked shares must not be burned');
  assert.ok(free>=0n,'fully reserved financial capital invariant');
  return {assets,spotReserve,proReserve:f.proReserved,otherReserve:f.otherReserved,
    buffer:500n*UNIT,free,spotLiability:f.externalQ*price/UNIT,totalShares:f.totalShares,lockedShares:f.lockedShares};
}

async function run(argv,env) {
  const stage=argv[0]??'preflight';
  const {demo,label,maxContribution}=runProfile(env);
  assert.ok(['preflight','setup','prepare-demo','graduate-demo','refresh','pro','down','cleanup','status',
    'trial-spot','trial-lp','trial-pro'].includes(stage));
  if(stage.endsWith('-demo'))assert.ok(demo,'demo stages require ANTE_UP_QA_PROFILE=demo');
  if(demo)assert.ok(['preflight','prepare-demo','graduate-demo','refresh','status',
    'trial-spot','trial-lp','trial-pro'].includes(stage),'unsupported trial stage');
  const dir=resolve(env.ANTE_UP_QA_STATE_DIR??'.runtime/financial-qa');
  const endpoint=(await readFile(env.ANTE_UP_QA_RPC_FILE,'utf8')).trim();
  const rpc=kit.createSolanaRpc(endpoint),transport=chain.createKitChainTransport(endpoint);
  assert.equal(await rpc.getGenesisHash().send(),GENESIS,'Devnet required');
  const program=await transport.getFinalizedAccount(chain.ANTE_UP_PROGRAM_ADDRESS);
  assert.ok(program.exists&&program.executable,'deployed program required');
  const core=(await chain.readFinalizedConfig(transport)).data;
  const fc=(await chain.readFinalizedFinanceConfig(transport)).data;
  assert.equal(core.admin,ADMIN);assert.equal(fc.admin,ADMIN);assert.equal(fc.paymentMint,MINT);
  const seed=digest(label),queryHash=digest(`SYNTHETIC QA ONLY: ${label}`);
  const [market]=await chain.findMarketPda({marketId:seed});
  const [fmAddress]=await chain.findFinanceMarketPda({market});
  const [keywordMint]=await chain.findKeywordMintPda({market});
  const [curveInventory]=await chain.findCurveInventoryPda({market});
  const [vaultInventory]=await chain.findVaultInventoryPda({market});
  const [paymentVault]=await chain.findPaymentVaultPda({market});
  const summary={label,synthetic:true,cluster:'devnet',programId:chain.ANTE_UP_PROGRAM_ADDRESS,market,
    marketSeedHex:Buffer.from(seed).toString('hex'),stage};
  const balance=async(address)=>{const a=await transport.getFinalizedAccount(address);
    if(!a.exists)return 0n;assert.equal(a.programAddress,spl.TOKEN_PROGRAM_ADDRESS);return spl.decodeToken(a).data.amount;};
  const finance=async()=>(await chain.readFinalizedFinanceMarket(transport,market)).data;
  const marketState=async()=>(await chain.readFinalizedMarket(transport,seed)).data;
  const now=()=>BigInt(Math.floor(Date.now()/1000));
  const adminSol=(await rpc.getBalance(kit.address(ADMIN),{commitment:'finalized'}).send()).value;
  const treasury=await balance(fc.protocolTreasury);
  if(stage==='preflight') {
    assert.ok(adminSol>=200_000_000n,'retain minimum admin gas reserve');
    assert.ok(treasury>=maxContribution+500n*UNIT,'max graduation contribution + QA funding');
    assert.ok(fc.supportedMarkets<10,'QA consumes one global supported-market slot');
    console.log(json({...summary,adminSol,treasury,supportedMarkets:fc.supportedMarkets,
      maxNewUserSol:60_000_000,maxQaTreasuryFunding:500n*UNIT,maxGraduationContribution:maxContribution,
      registryEntry:{address:market,seedHex:Buffer.from(seed).toString('hex'),keyword:'Synthetic finance demo',aliases:[],dataProvenance:'SYNTHETIC_QA'},
      normalMaturity:'next Monday UTC; cannot fast-forward on Devnet',writes:false}));return;
  }
  await mkdir(dir,{recursive:true});
  const journalPath=join(dir,'journal.json');
  let journal;
  try {journal=JSON.parse(await readFile(journalPath,'utf8'));assert.equal(journal.market,market);}
  catch(e){if(e.code!=='ENOENT')throw e;journal={...summary,steps:{},observations:[],audits:[]};}
  async function save(){const tmp=journalPath+'.tmp';await writeFile(tmp,json(journal),{mode:0o600});await replaceJournal(tmp,journalPath);}
  const keyPath=join(dir,'qa-wallet.json');
  let keyBytes;
  try{keyBytes=JSON.parse(await readFile(keyPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;
    assert.ok(['setup','prepare-demo'].includes(stage),'run setup/prepare-demo before status');
    const pair=generateKeyPairSync('ed25519');
    keyBytes=[...pair.privateKey.export({type:'pkcs8',format:'der'}).subarray(-32),...pair.publicKey.export({type:'spki',format:'der'}).subarray(-32)];
    await writeFile(keyPath,JSON.stringify(keyBytes),{flag:'wx',mode:0o600});}
  const user=await kit.createKeyPairSignerFromBytes(Uint8Array.from(keyBytes));
  journal.wallet=user.address;
  const [userPayment]=await spl.findAssociatedTokenPda({mint:kit.address(MINT),owner:user.address,tokenProgram:spl.TOKEN_PROGRAM_ADDRESS});
  const [userKeyword]=await spl.findAssociatedTokenPda({mint:keywordMint,owner:user.address,tokenProgram:spl.TOKEN_PROGRAM_ADDRESS});
  async function status(){const exists=await transport.getFinalizedAccount(fmAddress);let ledger=null;
    if(exists.exists){const f=await finance(),m=await marketState();
      if(m.phase===chain.MarketPhase.Indexed){const p=indexPrice(f.anchorPg,f.anchorSg,f.anchorDg,kit.unwrapOption(m.latestNowQ12),kit.unwrapOption(m.latest7dQ12)).price;
        ledger=auditFinance({finance:f,assets:await balance(paymentVault),price:p});}
      return {...summary,wallet:user.address,userTUSD:await balance(userPayment),userTokens:await balance(userKeyword),
        phase:m.phase,sequence:m.latestSequence,finance:f,ledger,steps:journal.steps,observations:journal.observations,audits:journal.audits};}
    return {...summary,wallet:user.address,created:false,steps:journal.steps};}
  if(stage==='status'){console.log(json(await status()));return;}
  const signer=async path=>kit.createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(await readFile(path,'utf8'))));
  const admin=await signer(env.ANTE_UP_QA_ADMIN_FILE),publisher=await signer(env.ANTE_UP_QA_PUBLISHER_FILE);
  assert.equal(admin.address,ADMIN);assert.equal(publisher.address,core.publisher);
  async function send(name,build,feePayer=user){
    let attempt=journal.steps[name];
    if(attempt){assert.ok(attempt.signature,'incomplete signing attempt needs manual review');
      const s=await transport.getSignatureStatus(attempt.signature);
      if(s?.err!=null)throw new Error(`FAILED_${name}: ${json(s.err)}`);
      if(s?.confirmationStatus==='finalized'){attempt.state='FINALIZED';await save();return;}
      throw new Error(`UNKNOWN_${name}: do not resend; reconcile ${attempt.signature}`);}
    const instructions=await build();
    let msg=kit.setTransactionMessageFeePayerSigner(feePayer,kit.createTransactionMessage({version:0}));
    const lifetime=await transport.getLatestBlockhash();
    msg=kit.setTransactionMessageLifetimeUsingBlockhash({...lifetime,blockhash:kit.blockhash(lifetime.blockhash)},msg);
    for(const ix of instructions)msg=kit.appendTransactionMessageInstruction(ix,msg);
    const tx=await kit.signTransactionMessageWithSigners(msg);
    const signature=kit.getSignatureFromTransaction(tx);
    attempt=journal.steps[name]={signature,state:'SIGNED',lastValidBlockHeight:lifetime.lastValidBlockHeight.toString()};await save();
    const wire=kit.getBase64Decoder().decode(kit.getTransactionEncoder().encode(tx));
    try{assert.equal(await transport.sendTransaction(wire),signature);}catch(e){
      attempt.state='UNKNOWN';attempt.error=safeError(e);
      const details=e?.context?.data??e?.context;
      if(details?.logs)attempt.preflight={err:details.err??null,logs:details.logs.map(x=>safeError({message:x}))};
      else try{const diagnostic=await rpc.simulateTransaction(wire,{encoding:'base64',commitment:'confirmed',sigVerify:false,replaceRecentBlockhash:true}).send();
        attempt.followupSimulation={at:now().toString(),err:diagnostic.value.err,logs:diagnostic.value.logs?.map(x=>safeError({message:x}))};
      }catch{attempt.followupSimulation={unavailable:true};}
      await save();throw new Error(`SEND_${name}_UNKNOWN: ${signature}`);}
    for(let n=0;n<40;n++){const s=await transport.getSignatureStatus(signature);
      if(s?.err!=null){attempt.state='FAILED';await save();throw new Error(`FAILED_${name}: ${json(s.err)}`);}
      if(s?.confirmationStatus==='finalized'){attempt.state='FINALIZED';await save();console.log(json({step:name,signature,state:'FINALIZED'}));return;}
      await sleep(1500);}
    attempt.state='UNKNOWN';await save();throw new Error(`CONFIRM_${name}_UNKNOWN`);
  }
  async function quote(){const f=await finance(),m=await marketState();
    const clock=await transport.getFinalizedAccount(kit.address('SysvarC1ock11111111111111111111111111111111'));
    const chainTime=Buffer.from(clock.data).readBigInt64LE(32);
    return {expectedSequence:m.latestSequence,expectedConfigVersion:core.configVersion,expectedStateVersion:f.stateVersion,deadline:chainTime+25n};}
  async function observe(name,activity=125n){await send(name,async()=>{const m=await marketState(),sequence=m.latestSequence+1n;
    let item=journal.observations.find(x=>x.jobName===name);
    if(item){assert.equal(item.candidate.sequence,sequence.toString(),'prepared snapshot sequence changed');}
    else{item={...syntheticCandidate({market,sequence,queryHash,configVersion:core.configVersion,computedAt:Number(now()),activity,label}),jobName:name};
      journal.observations.push(item);await save();}
    const observation=item.candidate;
    // Dedicated file only. Root configures the sole public indexer to import this
    // additional candidate source before any QA publication can be submitted.
    const candidates={jobs:Object.fromEntries(journal.observations.map(x=>[x.candidate.sequence,
      {...x,market:{address:market,cluster:'devnet',programId:chain.ANTE_UP_PROGRAM_ADDRESS,
        logicalId:label,seedHex:Buffer.from(seed).toString('hex')},state:'PREPARED'}])),snapshots:{}};
    const candidatePath=join(dir,'candidates.json'),candidateTmp=candidatePath+'.tmp';
    await writeFile(candidateTmp,json(candidates),{mode:0o600});await replaceJournal(candidateTmp,candidatePath);
    assert.equal(env.ANTE_UP_QA_CANDIDATE_IMPORT_READY,'yes','sole indexer extra candidate source must be configured first');
    return [await chain.getPublishSnapshotInstructionAsync({market,publisher,sequence,queryHash,queryVersion:1n,
      configVersion:core.configVersion,formulaVersion:core.formulaVersion,dataThrough:BigInt(observation.dataThrough),
      activityNowQ12:BigInt(observation.activityNowQ12),activity7dQ12:BigInt(observation.activity7dQ12),dataStatus:chain.DataStatus.Valid,
      admission:{state:chain.AdmissionState.Open,recoveryCount:0,reason:null},
      evidenceHash:Uint8Array.from(Buffer.from(observation.evidenceHash,'hex')),
      payloadHash:Uint8Array.from(Buffer.from(item.candidateHash,'hex'))})];},publisher);}
  async function audit(name){const s=await status();if(journal.audits.some(x=>x.name===name))return s;
    journal.audits.push({name,at:now().toString(),ledger:s.ledger,
    userTUSD:s.userTUSD,userTokens:s.userTokens});await save();return s;}
  const curveAccounts={market,keywordMint,curveInventory,paymentVault,paymentMint:kit.address(MINT),userKeyword,userPayment,protocolTreasury:fc.protocolTreasury,user};
  const spotAccounts={...curveAccounts,vaultInventory};
  const lpAccounts={market,paymentMint:kit.address(MINT),paymentVault,ownerPayment:userPayment,owner:user};
  if(stage==='setup'||stage==='prepare-demo'){
    assert.ok(adminSol>=200_000_000n);assert.ok(treasury>=maxContribution+500n*UNIT);
    await send('fund-sol',async()=>[system.getTransferSolInstruction({source:admin,destination:user.address,amount:60_000_000n})],admin);
    await send('create-payment-ata',async()=>[spl.getCreateAssociatedTokenIdempotentInstruction({payer:user,ata:userPayment,
      owner:user.address,mint:kit.address(MINT),tokenProgram:spl.TOKEN_PROGRAM_ADDRESS})]);
    await send('faucet',async()=>[await chain.getClaimFaucetInstructionAsync({wallet:user,paymentMint:kit.address(MINT),recipientPayment:userPayment})]);
    await send('fund-tusd',async()=>[spl.getTransferCheckedInstruction({source:fc.protocolTreasury,mint:kit.address(MINT),destination:userPayment,
      authority:admin,amount:500n*UNIT,decimals:6})],admin);
    await send('register',async()=>[await chain.getRegisterFinancialMarketInstructionAsync({registrant:user,marketId:seed,queryHash,queryVersion:1n,
      paymentMint:kit.address(MINT),registrantPayment:userPayment,protocolTreasury:fc.protocolTreasury})]);
    await send('create-keyword-ata',async()=>[spl.getCreateAssociatedTokenIdempotentInstruction({payer:user,ata:userKeyword,
      owner:user.address,mint:keywordMint,tokenProgram:spl.TOKEN_PROGRAM_ADDRESS})]);
    await send('curve-buy',async()=>[await chain.getCurveBuyInstructionAsync({...curveAccounts,quantity:1000n*UNIT,maxPayment:1102n*UNIT,...await quote()})]);
    await send('curve-sell',async()=>[await chain.getCurveSellInstructionAsync({...curveAccounts,quantity:UNIT,minReceipt:UNIT,...await quote()})]);
    await send('curve-rebuy',async()=>[await chain.getCurveBuyInstructionAsync({...curveAccounts,quantity:UNIT,maxPayment:2n*UNIT,...await quote()})]);
    if(stage==='prepare-demo'){
      const m=await marketState();assert.equal(m.phase,chain.MarketPhase.Curve);
      console.log(json({...summary,prepared:true,graduated:false,next:'Root enables indexer candidate import, then graduate-demo when UI/user are ready',report:await status()}));return;
    }
  }
  if(stage==='setup'||stage==='graduate-demo'){
    await observe('graduation-observation');
    await send('graduate',async()=>{const m=await marketState();const [snapshot]=await chain.findSnapshotPda({market,sequence:m.latestSequence});
      return [await chain.getGraduateInstructionAsync({market,snapshot,paymentMint:kit.address(MINT),paymentVault,supportPayment:fc.protocolTreasury,
        admin,maxContribution,...await quote()})];},admin);
    await audit('graduated');
    if(stage==='graduate-demo'){
      const f=await finance();
      console.log(json({...summary,graduated:true,lpWindowEnd:f.proReopenAt,next:'LP deposit/withdraw now; refresh every 240 seconds; Pro opens after lpWindowEnd',report:await status()}));return;
    }
    await send('spot-buy',async()=>[await chain.getSpotBuyInstructionAsync({...spotAccounts,quantity:10n*UNIT,maxPayment:13n*UNIT,...await quote()})]);
    await send('spot-sell',async()=>[await chain.getSpotSellInstructionAsync({...spotAccounts,quantity:10n*UNIT,minReceipt:11n*UNIT,...await quote()})]);
    await send('lp-deposit',async()=>[await chain.getDepositLpInstructionAsync({...lpAccounts,amount:200n*UNIT,minShares:1n,...await quote()})]);
    await audit('lp-deposited');
    const [holding]=await chain.findHoldingPda({market,owner:user.address});
    await send('lp-withdraw',async()=>{const h=chain.decodeLpHolding(await transport.getFinalizedAccount(holding)).data;
      return [await chain.getWithdrawLpInstructionAsync({...lpAccounts,shares:h.shares,minReceipt:199n*UNIT,...await quote()})];});
    const f=await finance();assert.equal(f.totalShares,f.lockedShares);assert.equal(f.externalQ,1000n*UNIT);
    await audit('setup-complete');
    console.log(json({...summary,next:'refresh every < 600 seconds until proReopenAt, then pro',proReopenAt:f.proReopenAt}));
  } else if(stage==='trial-spot'){
    assert.ok(demo,'trial trading requires an explicitly labelled market');
    const m=await marketState(),f=await finance();
    assert.equal(m.phase,chain.MarketPhase.Indexed);
    assert.equal(f.openPositions,0);
    assert.ok(Number(now()-m.latestDataThrough)<600,'fresh trial observation required');
    const before=await balance(userKeyword);
    await send('trial-spot-buy-20261016',async()=>[await chain.getSpotBuyInstructionAsync({
      ...spotAccounts,quantity:UNIT,maxPayment:2n*UNIT,...await quote()})]);
    assert.equal(await balance(userKeyword),before+UNIT);
    await send('trial-spot-sell-20261016',async()=>[await chain.getSpotSellInstructionAsync({
      ...spotAccounts,quantity:UNIT,minReceipt:UNIT,...await quote()})]);
    assert.equal(await balance(userKeyword),before);
    await audit('trial-spot-roundtrip-20261016');
    console.log(json({...summary,complete:['spot-buy','spot-sell'],report:await status()}));
  } else if(stage==='trial-lp'){
    assert.ok(demo,'trial LP requires an explicitly labelled market');
    const m=await marketState(),f=await finance(),clock=Number(now());
    assert.equal(m.phase,chain.MarketPhase.Indexed);
    assert.equal(f.openPositions,0);
    assert.ok(clock>=Number(f.lpWindowStart)&&clock<Number(f.lpWindowEnd),'LP window must be open');
    assert.ok(clock-Number(m.latestDataThrough)<600,'fresh trial observation required');
    const [holding]=await chain.findHoldingPda({market,owner:user.address});
    const prior=await transport.getFinalizedAccount(holding);
    assert.ok(!prior.exists||chain.decodeLpHolding(prior).data.shares===0n,'trial wallet must start without LP shares');
    await send('trial-lp-deposit-20261016',async()=>[await chain.getDepositLpInstructionAsync({
      ...lpAccounts,amount:10n*UNIT,minShares:1n,...await quote()})]);
    const deposited=chain.decodeLpHolding(await transport.getFinalizedAccount(holding)).data.shares;
    assert.ok(deposited>0n);
    await audit('trial-lp-deposited-20261016');
    await send('trial-lp-withdraw-20261016',async()=>[await chain.getWithdrawLpInstructionAsync({
      ...lpAccounts,shares:deposited,minReceipt:9n*UNIT,...await quote()})]);
    assert.equal(chain.decodeLpHolding(await transport.getFinalizedAccount(holding)).data.shares,0n);
    await audit('trial-lp-withdrawn-20261016');
    console.log(json({...summary,complete:['lp-deposit','lp-withdraw'],report:await status()}));
  } else if(stage==='cleanup'){
    for(const id of [1,2,3,4])assert.equal(journal.steps[`claim-${id}`]?.state,'FINALIZED','complete both Pro scenarios first');
    await send('cleanup-spot-sell',async()=>{
      const f=await finance(),m=await marketState(),quantity=await balance(userKeyword);
      assert.equal(f.openPositions,0);assert.equal(f.proReserved,0n);assert.equal(f.otherReserved,0n);
      assert.equal(quantity,1000n*UNIT);assert.equal(f.externalQ,quantity,'only QA-owned tokens may be redeemed');
      const price=indexPrice(f.anchorPg,f.anchorSg,f.anchorDg,kit.unwrapOption(m.latestNowQ12),kit.unwrapOption(m.latest7dQ12)).price;
      const gross=quantity*price/UNIT,fee=tradeFee(gross);
      journal.cleanup={quantity,price,gross,fee,expectedReceipt:gross-fee.total,userBefore:await balance(userPayment)};await save();
      return [await chain.getSpotSellInstructionAsync({...spotAccounts,quantity,minReceipt:gross-fee.total,...await quote()})];
    });
    const f=await finance();assert.equal(f.externalQ,0n);assert.equal(await balance(userKeyword),0n);
    assert.equal((await balance(userPayment))-BigInt(journal.cleanup.userBefore),BigInt(journal.cleanup.expectedReceipt));
    assert.equal(f.totalShares,f.lockedShares);await audit('cleanup-complete');
    console.log(json({...summary,cleanup:journal.cleanup,report:await status()}));
  } else if(stage==='refresh'){
    const scenario=demo?(env.ANTE_UP_QA_SCENARIO??'baseline'):'baseline';
    assert.ok(['baseline','up','down'].includes(scenario),'unsupported explicit synthetic scenario');
    const activity={baseline:125n,up:150n,down:100n}[scenario];
    await observe(`heartbeat-${scenario}-${Math.floor(Number(now())/240)}`,activity);console.log(json(await status()));
  } else if(stage==='pro'||stage==='down'||stage==='trial-pro'){
    if(stage==='trial-pro')assert.ok(demo,'trial Pro requires an explicitly labelled market');
    const f=await finance();assert.ok(now()>=f.proReopenAt,'wait for the actual 900-second LP window');
    if(stage==='trial-pro'){
      assert.equal(f.lpGeneration,(await marketState()).validityGeneration,'LP window must match the current data validity generation');
      assert.equal(f.currentMaturity,0n,'trial cycle must not have started');
      assert.equal(f.openPositions,0,'trial market must have no prior open positions');
      assert.ok(await balance(userPayment)>=220n*UNIT,'trial wallet must fund both bounded positions');
    }
    const firstId=stage==='down'?3n:1n,entryActivity=stage==='down'?150n:125n,exitActivity=stage==='down'?100n:150n;
    await observe(`${stage}-entry-observation`,entryActivity);
    if(stage==='trial-pro'){
      const latest=await finance();
      assert.equal(latest.lpGeneration,(await marketState()).validityGeneration,'fresh observation invalidated the LP window');
      assert.ok(now()>=latest.lpWindowEnd,'trial Pro must wait until the LP window closes');
    }
    const pAccounts={market,paymentMint:kit.address(MINT),paymentVault,ownerPayment:userPayment,protocolTreasury:fc.protocolTreasury,owner:user};
    for(const [id,direction] of [[firstId,chain.PositionDirection.Long],[firstId+1n,chain.PositionDirection.Short]]) {
      const step=stage==='trial-pro'?`trial-open-${id}-20261016`:`open-${id}`;
      await send(step,async()=>[await chain.getOpenProInstructionAsync({...pAccounts,positionId:id,collateral:100n*UNIT,
        leverageBps:50000n,direction,maxPayment:110n*UNIT,...await quote()})]);}
    await audit(`${stage}-long-short-open`);
    await observe(`${stage}-exit-observation`,exitActivity);
    for(const id of [firstId,firstId+1n]){
      const [position]=await chain.findPositionPda({market,owner:user.address,positionId:id});
      const [claim]=await chain.findClaimPda({position});
      const closeStep=stage==='trial-pro'?`trial-close-${id}-20261016`:`close-${id}`;
      await send(closeStep,async()=>{const current=await finance();const [settlement]=await chain.findSettlementPda(market,current.currentCycle);
        return [await chain.getCloseProInstructionAsync({market,position,settlement,owner:user,minReceipt:0n,...await quote()})];});
      const c=chain.decodeProClaim(await transport.getFinalizedAccount(claim)).data;
      const positionData=chain.decodeProPosition(await transport.getFinalizedAccount(position)).data;
      const finalPrice=indexPrice(f.anchorPg,f.anchorSg,f.anchorDg,exitActivity*Q12,100n*Q12).price;
      const terms=pro(positionData.collateral,positionData.leverageBps,positionData.entryPrice,finalPrice,f.pmax,
        id===firstId?'long':'short');
      assert.equal(c.payout,terms.payout);assert.equal(positionData.settlementPrice,finalPrice);
      assert.ok(c.refund<=positionData.prepaidFee);
      journal.positionResults??={};journal.positionResults[id]={direction:id===firstId?'long':'short',
        entryPrice:positionData.entryPrice,exitPrice:finalPrice,grossPayout:c.payout,
        entryTradingFee:tradeFee(positionData.notional).total,prepaidFee:positionData.prepaidFee,refund:c.refund,
        earnedTimeFee:positionData.prepaidFee-c.refund};await save();
      const before=await balance(userPayment);
      const wasPaid=c.paid;
      const claimStep=stage==='trial-pro'?`trial-claim-${id}-20261016`:`claim-${id}`;
      await send(claimStep,async()=>[await chain.getClaimProInstructionAsync({market,position,paymentMint:kit.address(MINT),paymentVault,ownerPayment:userPayment,owner:user})]);
      if(!wasPaid)assert.equal((await balance(userPayment))-before,c.payout+c.refund);
      assert.equal(chain.decodeProClaim(await transport.getFinalizedAccount(claim)).data.paid,true);
      await audit(`claimed-${id}`);
    }
    const end=await finance();assert.equal(end.openPositions,0);assert.equal(end.proReserved,0n);assert.equal(end.otherReserved,0n);
    console.log(json({...summary,complete:['curve','graduation','spot','LP','5x-long-short','early-close','claim'],
      normalMaturityNotExecuted:end.currentMaturity,report:await status()}));
  }
}
export async function main(argv=process.argv.slice(2),env=process.env) {
  if(['preflight','status'].includes(argv[0]??'preflight'))return run(argv,env);
  const dir=resolve(env.ANTE_UP_QA_STATE_DIR??'.runtime/financial-qa');
  await mkdir(dir,{recursive:true});
  const path=join(dir,'writer.lock');
  let lock;
  try{lock=await open(path,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw new Error('QA_WRITER_LOCKED: do not overlap setup/refresh/pro/down');throw e;}
  try{await lock.writeFile(json({pid:process.pid,stage:argv[0],startedAt:new Date().toISOString()}));return await run(argv,env);}
  finally{await lock.close();await unlink(path);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
