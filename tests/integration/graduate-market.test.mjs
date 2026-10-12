import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import * as chain from '../../clients/chain/dist/index.js';
import {createGraduatePlan,createGraduateRuntime,executeGraduation,
  FileGraduationJournal} from '../../scripts/graduate-market.mjs';

const chainRequire=createRequire(new URL('../../clients/chain/package.json',import.meta.url));
const kit=chainRequire('@solana/kit'),spl=chainRequire('@solana-program/token');
const [adminSigner,mintSigner]=await Promise.all([kit.generateKeyPairSigner(),
  kit.generateKeyPairSigner()]);
const now=1_800_000_000;
const config={cluster:'localnet',programId:chain.ANTE_UP_PROGRAM_ADDRESS,
  marketSeedHex:'07'.repeat(32),admin:adminSigner.address,
  paymentMint:mintSigner.address,maxContributionAtoms:'10000000000'};
const offline=await createGraduatePlan(config,null,{now});
const a=offline.accounts;
const [,financeMarketBump]=await chain.findFinanceMarketPda({market:a.market},
  {programAddress:config.programId});
const [snapshotAddress]=await chain.findSnapshotPda({market:a.market,sequence:4n},
  {programAddress:config.programId});
const owned=(address,ownerProgramId,other={})=>({address,ownerProgramId,
  finality:'finalized',...other});
function fixture(){return {
  program:owned(config.programId,'BPFLoaderUpgradeab1e11111111111111111111111',{executable:true}),
  config:owned(a.config,config.programId,{admin:config.admin,configVersion:'2',
    formulaVersion:Buffer.from('h3-d7-q12-v1'.padEnd(16,'\0')).toString('hex')}),
  financeConfig:owned(a.financeConfig,config.programId,{admin:config.admin,
    paymentMint:config.paymentMint,supportedMarkets:0,supportSpent:'0'}),
  market:owned(a.market,config.programId,{seedHex:config.marketSeedHex,phase:'CURVE',
    dataStatus:'VALID',admission:'OPEN',queryVersion:'1',queryHash:'b'.repeat(64),
    latestSequence:'4',latestHash:'c'.repeat(64),latestDataThrough:String(now-100),
    latestNowQ12:'100000000000000',latest7dQ12:'100000000000000'}),
  financeMarket:owned(a.financeMarket,config.programId,{market:a.market,
    bump:financeMarketBump,paymentVault:a.paymentVault,stateVersion:'5',curveSold:'1000000000',
    curveReserve:'1100000000',marketFees:'0',proReserved:'0',otherReserved:'0'}),
  snapshot:owned(String(snapshotAddress),config.programId,{market:a.market,sequence:'4',
    payloadHash:'c'.repeat(64),queryVersion:'1',queryHash:'b'.repeat(64),
    configVersion:'2',dataStatus:'VALID',admission:'OPEN',
    formulaVersion:Buffer.from('h3-d7-q12-v1'.padEnd(16,'\0')).toString('hex'),
    dataThrough:String(now-100),
    activityNowQ12:'100000000000000',activity7dQ12:'100000000000000'}),
  paymentMint:owned(config.paymentMint,spl.TOKEN_PROGRAM_ADDRESS,{decimals:6,
    isInitialized:true,mintAuthority:a.financeConfig,freezeAuthority:null}),
  paymentVault:owned(a.paymentVault,spl.TOKEN_PROGRAM_ADDRESS,{mint:config.paymentMint,
    owner:a.financeMarket,state:spl.AccountState.Initialized,amountAtoms:'1100000000'}),
  supportPayment:owned(a.supportPayment,spl.TOKEN_PROGRAM_ADDRESS,{mint:config.paymentMint,
    owner:config.admin,state:spl.AccountState.Initialized,amountAtoms:'50000000000'}),
};}

test('default CLI is offline and ready plan binds exact generated graduate instruction',async()=>{
  assert.equal(offline.state,'UNVERIFIED');
  assert.equal(offline.accounts.supportPayment,a.supportPayment);
  const script=fileURLToPath(new URL('../../scripts/graduate-market.mjs',import.meta.url));
  const env={...process.env,ANTE_UP_GRADUATE_CLUSTER:config.cluster,
    ANTE_UP_GRADUATE_PROGRAM_ID:config.programId,
    ANTE_UP_GRADUATE_MARKET_SEED_HEX:config.marketSeedHex,
    ANTE_UP_GRADUATE_ADMIN:config.admin,
    ANTE_UP_GRADUATE_PAYMENT_MINT:config.paymentMint,
    ANTE_UP_GRADUATE_MAX_CONTRIBUTION_ATOMS:config.maxContributionAtoms,
    ANTE_UP_GRADUATE_RPC_URL:''};
  const dry=spawnSync(process.execPath,[script],{env,encoding:'utf8'});
  assert.equal(dry.status,0,dry.stderr);
  assert.equal(JSON.parse(dry.stdout).state,'UNVERIFIED');
  const explicit=spawnSync(process.execPath,[script,'--execute'],{env,encoding:'utf8'});
  assert.notEqual(explicit.status,0);
  assert.match(explicit.stderr,/GRADUATE_JOURNAL_REQUIRED/);
  const noKey=spawnSync(process.execPath,[script,'--execute'],{env:{...env,
    ANTE_UP_GRADUATE_JOURNAL_FILE:'unused-graduation-journal.json'},encoding:'utf8'});
  assert.notEqual(noKey.status,0);
  assert.match(noKey.stderr,/GRADUATE_ADMIN_KEYPAIR_REQUIRED/);
  const plan=await createGraduatePlan(config,fixture(),{now});
  assert.equal(plan.state,'READY');
  assert.equal(plan.quote.contributionAtoms,'8400000000');
  assert.equal(plan.quote.supportedMarketsAfter,1);
  assert.equal(plan.quote.deadline,now+20);
  assert.equal(plan.instruction.accountAddresses[4],String(snapshotAddress));
  assert.equal(plan.instruction.accountAddresses[7],a.supportPayment);
  const decoded=chain.getGraduateInstructionDataDecoder().decode(
    Uint8Array.from(Buffer.from(plan.instruction.dataHex,'hex')));
  assert.equal(decoded.expectedSequence,4n);
  assert.equal(decoded.expectedConfigVersion,2n);
  assert.equal(decoded.expectedStateVersion,5n);
  assert.equal(decoded.maxContribution,8400000000n);
  assert.equal(decoded.deadline,BigInt(now+20));
});

test('readiness, identities, quote freshness, support limits and Indexed state fail closed',async()=>{
  const invalid=[
    [{financeMarket:{curveSold:'999999999'}},/GRADUATE_QCAP_NOT_READY/],
    [{market:{dataStatus:'OUTAGE'}},/GRADUATE_DATA_NOT_READY/],
    [{market:{latestDataThrough:String(now-600)},snapshot:{dataThrough:String(now-600)}},
      /GRADUATE_SNAPSHOT_STALE/],
    [{financeConfig:{supportedMarkets:5}},/SUPPORT_MARKET_LIMIT/],
    [{financeConfig:{supportSpent:'45000000000'}},/GRADUATE_SUPPORT_TOTAL/],
    [{supportPayment:{amountAtoms:'8399999999'}},/GRADUATE_SUPPORT_BALANCE/],
    [{paymentVault:{owner:config.admin}},/TOKEN_ACCOUNT_IDENTITY_MISMATCH/],
    [{snapshot:{payloadHash:'d'.repeat(64)}},/SNAPSHOT_STATE_MISMATCH/],
  ];
  for(const [patch,error] of invalid){
    const state=fixture();
    for(const [key,value] of Object.entries(patch))Object.assign(state[key],value);
    await assert.rejects(createGraduatePlan(config,state,{now}),error);
  }
  await assert.rejects(createGraduatePlan({...config,maxContributionAtoms:'8000000000'},fixture(),
    {now}),/GRADUATE_CONTRIBUTION_CAP/);
  const indexed=fixture();indexed.market.phase='INDEXED';
  assert.equal((await createGraduatePlan(config,indexed,{now})).state,'ALREADY_INDEXED');
});

test('Kit writer records the signature before an uncertain send and validates genesis',async()=>{
  const genesis=kit.getBase58Decoder().decode(new Uint8Array(32).fill(6));
  const blockhash=kit.getBase58Decoder().decode(new Uint8Array(32).fill(9));
  let sends=0,recorded=null,status=null;
  const rpc={getGenesisHash:()=>({send:async()=>genesis})};
  const transport={getLatestBlockhash:async()=>({blockhash,lastValidBlockHeight:100n}),
    getBlockHeight:async()=>50n,isBlockhashValid:async()=>true,
    sendTransaction:async()=>{sends++;throw Error('uncertain');},
    getSignatureStatus:async()=>status};
  const runtime=await createGraduateRuntime(config,{endpoint:'http://127.0.0.1:8899',
    expectedGenesisHash:genesis,adminSigner,rpc,transport,now:()=>now});
  const plan=await createGraduatePlan(config,fixture(),{mode:'EXECUTE',now});
  const result=await runtime.sendInstruction(plan,{onSigned:async signature=>{recorded=signature;}});
  assert.equal(result.state,'UNKNOWN');assert.equal(result.signature,recorded);
  assert.equal(sends,1);
  assert.equal(await runtime.signatureStatus(recorded),'UNKNOWN');
  status={confirmationStatus:'finalized',err:null};
  assert.equal(await runtime.signatureStatus(recorded),'FINALIZED');
  const late=await createGraduateRuntime(config,{endpoint:'http://127.0.0.1:8899',
    expectedGenesisHash:genesis,adminSigner,rpc,transport,now:()=>now+21});
  await assert.rejects(late.sendInstruction(plan,{onSigned:async()=>{}}),
    /GRADUATE_QUOTE_EXPIRED/);
  assert.equal(sends,1);
  const wrong=await createGraduateRuntime(config,{endpoint:'http://127.0.0.1:8899',
    expectedGenesisHash:kit.getBase58Decoder().decode(new Uint8Array(32).fill(8)),
    adminSigner,rpc,transport,now:()=>now});
  await assert.rejects(wrong.signatureStatus('sig'),/GRADUATE_GENESIS_MISMATCH/);
});

test('RPC reader decodes the finalized B accounts and SPL balances used by the plan',async()=>{
  const genesis=kit.getBase58Decoder().decode(new Uint8Array(32).fill(5));
  const hashBytes=value=>Uint8Array.from(Buffer.from(value.repeat(64),'hex'));
  const formula=Uint8Array.from(Buffer.from('h3-d7-q12-v1'.padEnd(16,'\0')));
  const encoded=(address,programAddress,data,executable=false)=>({exists:true,address,
    programAddress,data,executable,lamports:1n,space:BigInt(data.length)});
  const marketBytes=chain.getMarketEncoder().encode({id:Uint8Array.from(Buffer.from(config.marketSeedHex,'hex')),
    admin:config.admin,queryHash:hashBytes('b'),queryVersion:1n,
    phase:chain.MarketPhase.Curve,dataStatus:chain.DataStatus.Valid,
    admission:{state:chain.AdmissionState.Open,recoveryCount:0,reason:null},
    latestSequence:4n,latestHash:hashBytes('c'),latestDataThrough:BigInt(now-100),
    latestNowQ12:100000000000000n,latest7dQ12:100000000000000n,
    validityGeneration:0n});
  const financeMarketBytes=chain.getFinanceMarketEncoder().encode({market:a.market,
    keywordMint:config.admin,paymentVault:a.paymentVault,curveInventory:config.admin,
    vaultInventory:config.admin,bump:financeMarketBump,stateVersion:5n,
    curveSold:1000000000n,curveReserve:1100000000n,marketFees:0n,externalQ:0n,
    anchorPg:0n,anchorSg:0n,anchorDg:0n,pmax:0n,proReserved:0n,otherReserved:0n,
    openPositions:0,totalShares:0n,lockedShares:0n,lpWindowStart:0n,lpWindowEnd:0n,
    proReopenAt:0n,currentMaturity:0n,currentCycle:0n,lastLpMaturity:0n,lpGeneration:0n});
  const snapshotBytes=chain.getSnapshotEncoder().encode({market:a.market,sequence:4n,
    payloadHash:hashBytes('c'),evidenceHash:hashBytes('d'),queryHash:hashBytes('b'),
    queryVersion:1n,configVersion:2n,formulaVersion:formula,
    dataThrough:BigInt(now-100),publishedAt:BigInt(now-100),
    activityNowQ12:100000000000000n,activity7dQ12:100000000000000n,
    dataStatus:chain.DataStatus.Valid,
    admission:{state:chain.AdmissionState.Open,recoveryCount:0,reason:null}});
  const tokenBytes=(owner,amount)=>spl.getTokenEncoder().encode({mint:config.paymentMint,
    owner,amount,delegate:null,state:spl.AccountState.Initialized,isNative:null,
    delegatedAmount:0n,closeAuthority:null});
  const accounts=new Map([
    [config.programId,encoded(config.programId,'BPFLoaderUpgradeab1e11111111111111111111111',
      new Uint8Array(),true)],
    [a.config,encoded(a.config,config.programId,chain.getConfigEncoder().encode({
      admin:config.admin,publisher:config.admin,proofAuthority:config.admin,
      formulaVersion:formula,configVersion:2n}))],
    [a.financeConfig,encoded(a.financeConfig,config.programId,
      chain.getFinanceConfigEncoder().encode({admin:config.admin,paymentMint:config.paymentMint,
        protocolTreasury:a.supportPayment,faucetAmount:1000000000n,faucetCooldown:86400n,
        faucetTotalLimit:500000000000n,faucetMinted:0n,supportedMarkets:0,supportSpent:0n}))],
    [a.market,encoded(a.market,config.programId,marketBytes)],
    [a.financeMarket,encoded(a.financeMarket,config.programId,financeMarketBytes)],
    [String(snapshotAddress),encoded(String(snapshotAddress),config.programId,snapshotBytes)],
    [config.paymentMint,encoded(config.paymentMint,spl.TOKEN_PROGRAM_ADDRESS,
      spl.getMintEncoder().encode({mintAuthority:a.financeConfig,supply:50000000000n,
        decimals:6,isInitialized:true,freezeAuthority:null}))],
    [a.paymentVault,encoded(a.paymentVault,spl.TOKEN_PROGRAM_ADDRESS,
      tokenBytes(a.financeMarket,1100000000n))],
    [a.supportPayment,encoded(a.supportPayment,spl.TOKEN_PROGRAM_ADDRESS,
      tokenBytes(config.admin,50000000000n))],
  ]);
  const runtime=await createGraduateRuntime(config,{endpoint:'http://127.0.0.1:8899',
    expectedGenesisHash:genesis,adminSigner,
    rpc:{getGenesisHash:()=>({send:async()=>genesis})},
    transport:{getFinalizedAccount:async address=>accounts.get(address)??{address,exists:false}},
    now:()=>now});
  const state=await runtime.readFinalizedState();
  assert.equal(state.financeMarket.bump,financeMarketBump);
  assert.equal(state.supportPayment.amountAtoms,'50000000000');
  assert.equal((await createGraduatePlan(config,state,{now})).state,'READY');
  accounts.set(a.supportPayment,encoded(a.supportPayment,config.programId,
    tokenBytes(config.admin,50000000000n)));
  await assert.rejects(createGraduatePlan(config,await runtime.readFinalizedState(),{now}),
    /SUPPORT_ACCOUNT_MISMATCH/);
});

test('journaled unknown transaction is never resent; Indexed recovery needs its finalized signature',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'ante-graduate-'));
  try{
    const journal=new FileGraduationJournal(join(directory,'journal.json'));
    const state=fixture();let sends=0,status='UNKNOWN';
    const runtime={expectedGenesisHash:'genesis-fixture',now:()=>now,
      readFinalizedState:async()=>structuredClone(state),
      signatureStatus:async()=>status,
      sendInstruction:async (_plan,{onSigned})=>{
        sends++;await onSigned('fixture-signature');return {state:'UNKNOWN',signature:'fixture-signature'};
      }};
    const first=await executeGraduation({config,runtime,journal});
    assert.equal(first.state,'PENDING_RECONCILIATION');assert.equal(sends,1);
    assert.equal((await journal.read()).pending.signature,'fixture-signature');
    const restart=await executeGraduation({config,runtime,journal:new FileGraduationJournal(journal.path)});
    assert.equal(restart.state,'PENDING_RECONCILIATION');assert.equal(sends,1);
    state.market.phase='INDEXED';
    assert.equal((await executeGraduation({config,runtime,journal})).state,'ALREADY_INDEXED');
    status='FINALIZED';
    assert.equal((await executeGraduation({config,runtime,journal})).state,'FINALIZED');
    assert.equal(sends,1);
    await assert.rejects(executeGraduation({config:{...config,maxContributionAtoms:'9000000000'},
      runtime,journal}),/GRADUATE_JOURNAL_SCOPE_MISMATCH/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
