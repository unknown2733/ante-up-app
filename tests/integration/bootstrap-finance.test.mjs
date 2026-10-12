import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {createRequire} from 'node:module';
import { ANTE_UP_PROGRAM_ADDRESS, findMarketPda, getConfigEncoder,getFinanceConfigEncoder,
  getInitializeFinanceInstructionDataDecoder } from '../../clients/chain/dist/index.js';
import { createBootstrapPlan, executeBootstrap, FileBootstrapJournal,
  bootstrapConfigFromEnv } from '../../scripts/bootstrap-finance.mjs';
import {buildFinanceStepInstructions,createFinanceBootstrapRuntime}
  from '../../scripts/bootstrap-finance-runtime.mjs';
const requireChain=createRequire(new URL('../../clients/chain/package.json',import.meta.url));
const kit=requireChain('@solana/kit');
const spl=requireChain('@solana-program/token');
const {generateKeyPairSigner,getBase58Decoder}=kit;

const [admin]=await findMarketPda({marketId:new Uint8Array(32).fill(3)});
const [paymentMint]=await findMarketPda({marketId:new Uint8Array(32).fill(4)});
const config={cluster:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS,admin:String(admin),
  paymentMint:String(paymentMint),faucetAmountAtoms:'1000000000',
  faucetCooldownSeconds:'86400',faucetGlobalCapAtoms:'500000000000'};

const program={address:ANTE_UP_PROGRAM_ADDRESS,executable:true,finality:'finalized'};
const coreAddress=(await createBootstrapPlan(config)).configPda;
const core={address:coreAddress,ownerProgramId:ANTE_UP_PROGRAM_ADDRESS,
  admin:config.admin,finality:'finalized'};
const mint=(authority,supplyAtoms='0')=>({address:config.paymentMint,
  ownerProgramId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',decimals:6,
  isInitialized:true,mintAuthority:authority,freezeAuthority:null,supplyAtoms,finality:'finalized'});
const treasury=(plan,amountAtoms='0')=>({address:plan.treasuryAta,
  ownerProgramId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  mint:config.paymentMint,owner:config.admin,state:spl.AccountState.Initialized,
  delegate:null,closeAuthority:null,amountAtoms,finality:'finalized'});
const finance=(plan)=>({address:plan.financeConfig,ownerProgramId:config.programId,
  admin:config.admin,paymentMint:config.paymentMint,protocolTreasury:plan.treasuryAta,
  faucetAmountAtoms:config.faucetAmountAtoms,faucetCooldownSeconds:config.faucetCooldownSeconds,
  faucetGlobalCapAtoms:config.faucetGlobalCapAtoms,faucetMintedAtoms:'0',finality:'finalized'});

test('dry-run derives classic SPL ATA, finance PDA and generated initialize instruction',async()=>{
  const plan=await createBootstrapPlan(config);
  assert.equal(plan.mode,'DRY_RUN');assert.equal(plan.next.kind,'UNVERIFIED');
  assert.deepEqual(plan.order,['CREATE_MINT','CREATE_TREASURY_ATA','MINT_SUPPORT',
    'TRANSFER_MINT_AUTHORITY','INITIALIZE_FINANCE']);
  assert.equal(plan.supportAtoms,'50000000000');
  assert.equal(plan.faucet.amountAtoms,'1000000000');
  assert.equal(plan.faucet.cooldownSeconds,'86400');
  assert.equal(plan.initializeFinance.accountAddresses[1],plan.financeConfig);
  assert.equal(plan.initializeFinance.accountAddresses[3],plan.treasuryAta);
  const decoded=getInitializeFinanceInstructionDataDecoder().decode(
    Uint8Array.from(Buffer.from(plan.initializeFinance.dataHex,'hex')));
  assert.equal(decoded.faucetAmount,1000000000n);
  assert.equal(decoded.faucetCooldown,86400n);
  assert.equal(decoded.faucetTotalLimit,500000000000n);
  const fromEnv=bootstrapConfigFromEnv({ANTE_UP_BOOTSTRAP_CLUSTER:'devnet',
    ANTE_UP_BOOTSTRAP_PROGRAM_ID:config.programId,ANTE_UP_BOOTSTRAP_ADMIN:config.admin,
    ANTE_UP_BOOTSTRAP_PAYMENT_MINT:config.paymentMint,
    ANTE_UP_BOOTSTRAP_FAUCET_GLOBAL_CAP_ATOMS:config.faucetGlobalCapAtoms});
  assert.equal(fromEnv.faucetAmountAtoms,'1000000000');
  await assert.rejects(createBootstrapPlan({...config,cluster:'mainnet-beta'}),/CLUSTER_MUST_BE_TESTNET/);
  await assert.rejects(createBootstrapPlan({...config,faucetGlobalCapAtoms:'1'}),/INVALID_FAUCET_CONFIG/);
});

test('CLI defaults to offline plan and execute flag needs a journal and live RPC settings',()=>{
  const script=fileURLToPath(new URL('../../scripts/bootstrap-finance.mjs',import.meta.url));
  const env={...process.env,ANTE_UP_BOOTSTRAP_CLUSTER:config.cluster,
    ANTE_UP_BOOTSTRAP_PROGRAM_ID:config.programId,ANTE_UP_BOOTSTRAP_ADMIN:config.admin,
    ANTE_UP_BOOTSTRAP_PAYMENT_MINT:config.paymentMint,
    ANTE_UP_BOOTSTRAP_FAUCET_GLOBAL_CAP_ATOMS:config.faucetGlobalCapAtoms,
    ANTE_UP_BOOTSTRAP_RUNTIME_MODULE:'',ANTE_UP_BOOTSTRAP_JOURNAL_FILE:''};
  const dry=spawnSync(process.execPath,[script],{env,encoding:'utf8'});
  assert.equal(dry.status,0,dry.stderr);
  assert.equal(JSON.parse(dry.stdout).mode,'DRY_RUN');
  const explicit=spawnSync(process.execPath,[script,'--execute'],{env,encoding:'utf8'});
  assert.notEqual(explicit.status,0);
  assert.match(explicit.stderr,/BOOTSTRAP_JOURNAL_FILE_REQUIRED/);
  const withJournal=spawnSync(process.execPath,[script,'--execute'],
    {env:{...env,ANTE_UP_BOOTSTRAP_JOURNAL_FILE:'unused-bootstrap-journal.json'},encoding:'utf8'});
  assert.notEqual(withJournal.status,0);
  assert.match(withJournal.stderr,/BOOTSTRAP_RPC_URL_REQUIRED/);
});

test('finalized reads advance one bootstrap stage and reject drift',async()=>{
  const plan=await createBootstrapPlan(config),state={program,coreConfig:core,mint:null,
    treasury:null,financeConfig:null};
  assert.equal((await createBootstrapPlan(config,state)).next.kind,'CREATE_MINT');
  state.mint=mint(config.admin);
  assert.equal((await createBootstrapPlan(config,state)).next.kind,'CREATE_TREASURY_ATA');
  state.treasury=treasury(plan);
  let next=(await createBootstrapPlan(config,state)).next;
  assert.equal(next.kind,'MINT_SUPPORT');assert.equal(next.amountAtoms,'50000000000');
  state.mint.supplyAtoms='50000000000';state.treasury.amountAtoms='50000000000';
  assert.equal((await createBootstrapPlan(config,state)).next.kind,'TRANSFER_MINT_AUTHORITY');
  state.mint.mintAuthority=plan.financeConfig;
  assert.equal((await createBootstrapPlan(config,state)).next.kind,'INITIALIZE_FINANCE');
  state.financeConfig=finance(plan);
  assert.equal((await createBootstrapPlan(config,state)).completed,true);
  const postFaucet=structuredClone(state);
  postFaucet.mint.supplyAtoms='51000000000';postFaucet.financeConfig.faucetMintedAtoms='1000000000';
  assert.equal((await createBootstrapPlan(config,postFaucet)).completed,true);
  await assert.rejects(createBootstrapPlan(config,{...state,mint:{...state.mint,decimals:9}}),
    /MINT_IDENTITY_MISMATCH/);
  await assert.rejects(createBootstrapPlan(config,{...state,financeConfig:{...state.financeConfig,
    faucetGlobalCapAtoms:'9'}}),/FINANCE_CONFIG_MISMATCH/);
  await assert.rejects(createBootstrapPlan(config,{...state,coreConfig:{...core,finality:'confirmed'}}),
    /CORE_CONFIG_NOT_FINALIZED/);
});

test('executor journals before send, reconciles uncertainty, and never duplicates a step',async()=>{
  const directory=await mkdtemp(join(process.cwd(),'ante-bootstrap-'));
  try{
    const journal=new FileBootstrapJournal(join(directory,'journal.json'));
    const plan=await createBootstrapPlan(config),state={program,coreConfig:core,mint:null,
      treasury:null,financeConfig:null};
    const sent=[];let withholdFirst=true;
    const runtime={readFinalizedState:async()=>structuredClone(state),
      async executeStep(step,{onSigned}){sent.push(step.kind);
        await onSigned(`fixture-${step.kind}`);
        if(step.kind==='CREATE_MINT' && withholdFirst)return {signature:'fixture-CREATE_MINT'};
        if(step.kind==='CREATE_MINT')state.mint=mint(config.admin);
        if(step.kind==='CREATE_TREASURY_ATA')state.treasury=treasury(plan);
        if(step.kind==='MINT_SUPPORT'){
          state.mint.supplyAtoms='50000000000';state.treasury.amountAtoms='50000000000';}
        if(step.kind==='TRANSFER_MINT_AUTHORITY')state.mint.mintAuthority=plan.financeConfig;
        if(step.kind==='INITIALIZE_FINANCE')state.financeConfig=finance(plan);
        return {signature:`fixture-${step.kind}`};}};
    const pending=await executeBootstrap({config,runtime,journal});
    assert.equal(pending.state,'PENDING_RECONCILIATION');
    assert.equal((await journal.read()).pending.signature,'fixture-CREATE_MINT');
    assert.deepEqual(sent,['CREATE_MINT']);
    const again=await executeBootstrap({config,runtime,journal:new FileBootstrapJournal(journal.path)});
    assert.equal(again.state,'PENDING_RECONCILIATION');assert.deepEqual(sent,['CREATE_MINT']);
    withholdFirst=false;state.mint=mint(config.admin); // finalized read recovers the ambiguous send.
    const complete=await executeBootstrap({config,runtime,journal:new FileBootstrapJournal(journal.path)});
    assert.equal(complete.state,'COMPLETE');
    assert.equal(complete.plan.mode,'EXECUTE');
    assert.deepEqual(sent,['CREATE_MINT','CREATE_TREASURY_ATA','MINT_SUPPORT',
      'TRANSFER_MINT_AUTHORITY','INITIALIZE_FINANCE']);
    assert.equal((await executeBootstrap({config,runtime,journal})).state,'COMPLETE');
    assert.equal(sent.length,5);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('real Kit/SPL writer builds every stage and journals a signed unknown send',async()=>{
  const adminSigner=await generateKeyPairSigner(),mintSigner=await generateKeyPairSigner();
  const liveConfig={...config,admin:adminSigner.address,paymentMint:mintSigner.address};
  const plan=await createBootstrapPlan(liveConfig);
  const genesis=getBase58Decoder().decode(new Uint8Array(32).fill(7));
  const blockhash=getBase58Decoder().decode(new Uint8Array(32).fill(9));
  const rpc={getGenesisHash:()=>({send:async()=>genesis}),
    getMinimumBalanceForRentExemption:()=>({send:async()=>1461600n})};
  const stages=[
    {kind:'CREATE_MINT'}, {kind:'CREATE_TREASURY_ATA'},
    {kind:'MINT_SUPPORT',amountAtoms:'50000000000'},
    {kind:'TRANSFER_MINT_AUTHORITY'}, {kind:'INITIALIZE_FINANCE'}];
  const instructions=await Promise.all(stages.map(step=>buildFinanceStepInstructions(step,
    {plan,config:liveConfig,adminSigner,mintSigner,rpc})));
  assert.equal(instructions[0].length,2);
  assert.equal(instructions[1][0].programAddress,spl.ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
  assert.equal(instructions[2][0].programAddress,spl.TOKEN_PROGRAM_ADDRESS);
  assert.equal(instructions[3][0].programAddress,spl.TOKEN_PROGRAM_ADDRESS);
  assert.equal(instructions[4][0].programAddress,liveConfig.programId);
  let sends=0,recorded=null,status=null;
  const transport={getLatestBlockhash:async()=>({blockhash,lastValidBlockHeight:100n}),
    isBlockhashValid:async()=>true,sendTransaction:async()=>{sends++;throw Error('uncertain');},
    getSignatureStatus:async()=>status,getBlockHeight:async()=>50n};
  const runtime=createFinanceBootstrapRuntime({config:liveConfig,rpc,transport,
    adminSigner,mintSigner,expectedGenesisHash:genesis});
  const result=await runtime.executeStep(stages[2],{plan,onSigned:async value=>{recorded=value;}});
  assert.equal(result.state,'UNKNOWN');assert.equal(result.signature,recorded);
  assert.equal(sends,1);
  assert.equal(await runtime.reconcilePending({signature:recorded}),'UNKNOWN');
  status={confirmationStatus:'finalized',err:null};
  assert.equal(await runtime.reconcilePending({signature:recorded}),'FINALIZED');
  assert.throws(()=>createFinanceBootstrapRuntime({...{config:liveConfig,rpc,transport,
    adminSigner,mintSigner},expectedGenesisHash:null}),/EXPECTED_GENESIS_HASH_REQUIRED/);
});

test('live reader decodes finalized Config and classic SPL mint before allowing a stage',async()=>{
  const adminSigner=await generateKeyPairSigner(),mintSigner=await generateKeyPairSigner();
  const liveConfig={...config,admin:adminSigner.address,paymentMint:mintSigner.address};
  const plan=await createBootstrapPlan(liveConfig);
  const genesis=getBase58Decoder().decode(new Uint8Array(32).fill(6));
  const encoded=(address,programAddress,data,executable=false)=>({exists:true,address,
    programAddress,data,executable,lamports:1n,space:BigInt(data.length)});
  const coreBytes=getConfigEncoder().encode({admin:liveConfig.admin,publisher:liveConfig.admin,
    proofAuthority:liveConfig.admin,formulaVersion:new Uint8Array(16),configVersion:1n});
  const mintBytes=spl.getMintEncoder().encode({mintAuthority:liveConfig.admin,supply:0n,
    decimals:6,isInitialized:true,freezeAuthority:null});
  const accounts=new Map([
    [liveConfig.programId,encoded(liveConfig.programId,liveConfig.programId,new Uint8Array(),true)],
    [plan.configPda,encoded(plan.configPda,liveConfig.programId,coreBytes)],
    [liveConfig.paymentMint,encoded(liveConfig.paymentMint,spl.TOKEN_PROGRAM_ADDRESS,mintBytes)],
  ]);
  const transport={getFinalizedAccount:async address=>accounts.get(address)??{exists:false,address}};
  const rpc={getGenesisHash:()=>({send:async()=>genesis})};
  const runtime=createFinanceBootstrapRuntime({config:liveConfig,rpc,transport,
    adminSigner,mintSigner,expectedGenesisHash:genesis});
  const state=await runtime.readFinalizedState(plan);
  assert.equal(state.coreConfig.admin,liveConfig.admin);
  assert.equal(state.mint.mintAuthority,liveConfig.admin);
  assert.equal((await createBootstrapPlan(liveConfig,state)).next.kind,'CREATE_TREASURY_ATA');
  const fundedMint=spl.getMintEncoder().encode({mintAuthority:plan.financeConfig,
    supply:50000000000n,decimals:6,isInitialized:true,freezeAuthority:null});
  const token=spl.getTokenEncoder().encode({mint:liveConfig.paymentMint,owner:liveConfig.admin,
    amount:50000000000n,delegate:null,state:spl.AccountState.Initialized,
    isNative:null,delegatedAmount:0n,closeAuthority:null});
  const financeBytes=getFinanceConfigEncoder().encode({admin:liveConfig.admin,
    paymentMint:liveConfig.paymentMint,protocolTreasury:plan.treasuryAta,
    faucetAmount:1000000000n,faucetCooldown:86400n,
    faucetTotalLimit:500000000000n,faucetMinted:0n,supportedMarkets:0,supportSpent:0n});
  accounts.set(liveConfig.paymentMint,encoded(liveConfig.paymentMint,spl.TOKEN_PROGRAM_ADDRESS,fundedMint));
  accounts.set(plan.treasuryAta,encoded(plan.treasuryAta,spl.TOKEN_PROGRAM_ADDRESS,token));
  accounts.set(plan.financeConfig,encoded(plan.financeConfig,liveConfig.programId,financeBytes));
  assert.equal((await createBootstrapPlan(liveConfig,await runtime.readFinalizedState(plan))).completed,true);
  accounts.set(liveConfig.paymentMint,encoded(liveConfig.paymentMint,liveConfig.programId,mintBytes));
  await assert.rejects(createBootstrapPlan(liveConfig,await runtime.readFinalizedState(plan)),
    /MINT_IDENTITY_MISMATCH/);
});
