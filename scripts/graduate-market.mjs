// Offline: set CLUSTER, PROGRAM_ID, MARKET_SEED_HEX, ADMIN, PAYMENT_MINT and
// MAX_CONTRIBUTION_ATOMS with the ANTE_UP_GRADUATE_ prefix, then run this file.
// A read-only finalized plan also uses RPC_URL and EXPECTED_GENESIS_HASH.
// --execute additionally needs ADMIN_KEYPAIR_FILE and JOURNAL_FILE. Only a
// localnet/devnet signer and a matching finalized genesis may submit.
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {replaceJournal} from './atomic-rename.mjs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as chain from '../clients/chain/dist/index.js';
import {UNIT,Q12,ceilDiv,indexPrice,freeCapital} from '../contracts/reference.mjs';

const chainRequire=createRequire(new URL('../clients/chain/package.json',import.meta.url));
const kit=chainRequire('@solana/kit');
const spl=chainRequire('@solana-program/token');
const check=(ok,code)=>{if(!ok)throw new Error(code);};
const decimal=x=>typeof x==='string' && /^(0|[1-9][0-9]*)$/.test(x);
const u64=x=>decimal(x) && BigInt(x)<=18_446_744_073_709_551_615n;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const CURVE_CAP=1_000n*UNIT,MIN_RESERVE=1_100n*UNIT;
const PER_MARKET=10_000n*UNIT,TOTAL=50_000n*UNIT;
const BUFFER=500n*UNIT,INITIAL_FREE=3_000n*UNIT,PG=1_200_000n;
const LOADER_PROGRAMS=new Set(['BPFLoaderUpgradeab1e11111111111111111111111',
  'BPFLoader2111111111111111111111111111111111']);
const option=value=>value==null?null:kit.unwrapOption(value);

export function graduateConfigFromEnv(env=process.env){
  return {cluster:env.ANTE_UP_GRADUATE_CLUSTER,programId:env.ANTE_UP_GRADUATE_PROGRAM_ID,
    marketSeedHex:env.ANTE_UP_GRADUATE_MARKET_SEED_HEX,admin:env.ANTE_UP_GRADUATE_ADMIN,
    paymentMint:env.ANTE_UP_GRADUATE_PAYMENT_MINT,
    maxContributionAtoms:env.ANTE_UP_GRADUATE_MAX_CONTRIBUTION_ATOMS};
}

function validateConfig(config){
  check(['localnet','devnet'].includes(config.cluster),'GRADUATE_CLUSTER_REQUIRED');
  check(kit.isAddress(config.programId) && kit.isAddress(config.admin) &&
    kit.isAddress(config.paymentMint),'GRADUATE_ADDRESS_REQUIRED');
  check(/^[a-f0-9]{64}$/.test(config.marketSeedHex) &&
    config.marketSeedHex!=='0'.repeat(64),'GRADUATE_MARKET_SEED_REQUIRED');
  check(u64(config.maxContributionAtoms) && BigInt(config.maxContributionAtoms)<=PER_MARKET,
    'GRADUATE_OPERATOR_CAP_REQUIRED');
}

async function addresses(config){
  const marketSeed=Uint8Array.from(Buffer.from(config.marketSeedHex,'hex'));
  const [configPda]=await chain.findConfigPda({programAddress:config.programId});
  const [financeConfigPda]=await chain.findFinanceConfigPda({programAddress:config.programId});
  const [market]=await chain.findMarketPda({marketId:marketSeed},{programAddress:config.programId});
  const [financeMarket,financeMarketBump]=await chain.findFinanceMarketPda({market},{programAddress:config.programId});
  const [paymentVault]=await chain.findPaymentVaultPda({market},{programAddress:config.programId});
  const [supportPayment]=await spl.findAssociatedTokenPda({mint:config.paymentMint,
    owner:config.admin,tokenProgram:spl.TOKEN_PROGRAM_ADDRESS});
  return {marketSeed,configPda:String(configPda),financeConfigPda:String(financeConfigPda),
    market:String(market),financeMarket:String(financeMarket),financeMarketBump,
    paymentVault:String(paymentVault),
    supportPayment:String(supportPayment)};
}

function account(value,address,owner,code){
  check(value?.address===address && value.ownerProgramId===owner &&
    value.finality==='finalized',code);
}

export async function createGraduatePlan(config,state=null,{now=Math.floor(Date.now()/1000),mode='DRY_RUN'}={}){
  validateConfig(config);
  check(['DRY_RUN','EXECUTE'].includes(mode),'GRADUATE_MODE_INVALID');
  check(Number.isSafeInteger(now) && now>=0 && now+30<=Number.MAX_SAFE_INTEGER,
    'GRADUATE_TIME_INVALID');
  const a=await addresses(config);
  const scope={cluster:config.cluster,programId:config.programId,admin:config.admin,
    market:a.market,paymentMint:config.paymentMint,maxContributionAtoms:config.maxContributionAtoms};
  const base={kind:'GRADUATE_MARKET_PLAN',mode,scope,marketSeedHex:config.marketSeedHex,
    accounts:{config:a.configPda,financeConfig:a.financeConfigPda,market:a.market,
      financeMarket:a.financeMarket,paymentMint:config.paymentMint,
      paymentVault:a.paymentVault,supportPayment:a.supportPayment,admin:config.admin,
      tokenProgram:spl.TOKEN_PROGRAM_ADDRESS}};
  if(state===null)return {...base,state:'UNVERIFIED',requiredFinalizedReads:[
    'program','config','financeConfig','market','financeMarket','snapshot',
    'paymentMint','paymentVault','supportPayment']};
  account(state.program,config.programId,state.program?.ownerProgramId,'PROGRAM_IDENTITY_MISMATCH');
  check(state.program.executable===true &&
    LOADER_PROGRAMS.has(state.program.ownerProgramId),'PROGRAM_NOT_DEPLOYED');
  account(state.config,a.configPda,config.programId,'CONFIG_IDENTITY_MISMATCH');
  account(state.financeConfig,a.financeConfigPda,config.programId,'FINANCE_CONFIG_IDENTITY_MISMATCH');
  account(state.market,a.market,config.programId,'MARKET_IDENTITY_MISMATCH');
  account(state.financeMarket,a.financeMarket,config.programId,'FINANCE_MARKET_IDENTITY_MISMATCH');
  check(state.config.admin===config.admin &&
    state.financeConfig.admin===config.admin &&
    state.financeConfig.paymentMint===config.paymentMint &&
    state.market.seedHex===config.marketSeedHex &&
    state.financeMarket.market===a.market &&
    state.financeMarket.bump===a.financeMarketBump &&
    state.financeMarket.paymentVault===a.paymentVault,
    'GRADUATE_ACCOUNT_LINK_MISMATCH');
  if(state.market.phase==='INDEXED')return {...base,state:'ALREADY_INDEXED'};
  check(state.market.phase==='CURVE','GRADUATE_WRONG_PHASE');
  account(state.paymentMint,config.paymentMint,spl.TOKEN_PROGRAM_ADDRESS,'PAYMENT_MINT_MISMATCH');
  check(state.paymentMint.decimals===6 && state.paymentMint.isInitialized===true &&
    state.paymentMint.mintAuthority===a.financeConfigPda &&
    state.paymentMint.freezeAuthority===null,
    'PAYMENT_MINT_MISMATCH');
  account(state.paymentVault,a.paymentVault,spl.TOKEN_PROGRAM_ADDRESS,'PAYMENT_VAULT_MISMATCH');
  account(state.supportPayment,a.supportPayment,spl.TOKEN_PROGRAM_ADDRESS,'SUPPORT_ACCOUNT_MISMATCH');
  check(state.paymentVault.mint===config.paymentMint &&
    state.paymentVault.owner===a.financeMarket &&
    state.paymentVault.state===spl.AccountState.Initialized &&
    state.supportPayment.mint===config.paymentMint &&
    state.supportPayment.owner===config.admin &&
    state.supportPayment.state===spl.AccountState.Initialized,
    'TOKEN_ACCOUNT_IDENTITY_MISMATCH');
  for(const value of [state.config.configVersion,state.market.latestSequence,
    state.financeMarket.stateVersion,state.financeMarket.curveSold,
    state.financeMarket.curveReserve,state.financeMarket.marketFees,
    state.financeMarket.proReserved,state.financeMarket.otherReserved,
    state.financeConfig.supportSpent,state.paymentVault.amountAtoms,
    state.supportPayment.amountAtoms])check(u64(value),'GRADUATE_NUMERIC_STATE_INVALID');
  check(Number.isSafeInteger(state.financeConfig.supportedMarkets) &&
    state.financeConfig.supportedMarkets>=0 && state.financeConfig.supportedMarkets<5,
    'SUPPORT_MARKET_LIMIT');
  check(BigInt(state.financeMarket.curveSold)===CURVE_CAP &&
    BigInt(state.financeMarket.curveReserve)>=MIN_RESERVE,'GRADUATE_QCAP_NOT_READY');
  check(state.market.dataStatus==='VALID' && state.market.admission==='OPEN' &&
    BigInt(state.market.latestSequence)>0n,'GRADUATE_DATA_NOT_READY');
  const [snapshotAddress]=await chain.findSnapshotPda({market:a.market,
    sequence:BigInt(state.market.latestSequence)},{programAddress:config.programId});
  account(state.snapshot,String(snapshotAddress),config.programId,'SNAPSHOT_IDENTITY_MISMATCH');
  check(state.snapshot.market===a.market &&
    state.snapshot.sequence===state.market.latestSequence &&
    state.snapshot.payloadHash===state.market.latestHash &&
    state.snapshot.dataStatus==='VALID' &&
    state.snapshot.admission==='OPEN' &&
    state.snapshot.formulaVersion===state.config.formulaVersion &&
    state.snapshot.queryVersion===state.market.queryVersion &&
    state.snapshot.queryHash===state.market.queryHash &&
    state.snapshot.configVersion===state.config.configVersion &&
    state.snapshot.activityNowQ12===state.market.latestNowQ12 &&
    state.snapshot.activity7dQ12===state.market.latest7dQ12 &&
    state.snapshot.dataThrough===state.market.latestDataThrough,
    'SNAPSHOT_STATE_MISMATCH');
  const through=Number(state.market.latestDataThrough);
  check(Number.isSafeInteger(through) && through<=now && now-through<600,
    'GRADUATE_SNAPSHOT_STALE');
  check(u64(state.market.latestNowQ12) && u64(state.market.latest7dQ12),
    'GRADUATE_ACTIVITY_REQUIRED');
  const s=BigInt(state.market.latestNowQ12),d=BigInt(state.market.latest7dQ12);
  check(s>=100n*Q12 && d>=100n*Q12 && s<5n*d,'GRADUATE_ACTIVITY_NOT_READY');
  const balance=BigInt(state.paymentVault.amountAtoms);
  check(balance>=BigInt(state.financeMarket.curveReserve)+BigInt(state.financeMarket.marketFees),
    'GRADUATE_VAULT_UNDERFUNDED');
  const pmax=indexPrice(PG,s,d,s,d).maximum;
  const reserve=ceilDiv(CURVE_CAP*pmax,UNIT);
  const target=reserve+BUFFER+INITIAL_FREE;
  const contribution=target>balance?target-balance:0n;
  check(contribution<=PER_MARKET && contribution<=BigInt(config.maxContributionAtoms),
    'GRADUATE_CONTRIBUTION_CAP');
  check(BigInt(state.financeConfig.supportSpent)+contribution<=TOTAL,
    'GRADUATE_SUPPORT_TOTAL');
  check(BigInt(state.supportPayment.amountAtoms)>=contribution,'GRADUATE_SUPPORT_BALANCE');
  const newAssets=balance+contribution,spotLiability=CURVE_CAP*PG/UNIT;
  check(newAssets>spotLiability &&
    freeCapital(newAssets,CURVE_CAP,pmax,BigInt(state.financeMarket.proReserved),
      BigInt(state.financeMarket.otherReserved),BUFFER)>=0n,'GRADUATE_INSOLVENT');
  const deadline=now+20; // On-chain quote accepts [now, now+30].
  const instruction=await chain.getGraduateInstructionAsync({market:a.market,
    snapshot:String(snapshotAddress),paymentMint:config.paymentMint,
    paymentVault:a.paymentVault,supportPayment:a.supportPayment,
    admin:kit.createNoopSigner(config.admin),
    expectedSequence:BigInt(state.market.latestSequence),
    expectedConfigVersion:BigInt(state.config.configVersion),
    expectedStateVersion:BigInt(state.financeMarket.stateVersion),
    deadline:BigInt(deadline),maxContribution:contribution},
  {programAddress:config.programId});
  const expected=[a.configPda,a.financeConfigPda,a.market,a.financeMarket,
    String(snapshotAddress),config.paymentMint,a.paymentVault,a.supportPayment,
    config.admin,spl.TOKEN_PROGRAM_ADDRESS];
  check(instruction.accounts.every((meta,i)=>meta.address===expected[i]) &&
    instruction.accounts.length===expected.length,'GRADUATE_INSTRUCTION_MISMATCH');
  return {...base,state:'READY',accounts:{...base.accounts,snapshot:String(snapshotAddress)},
    quote:{asOf:now,deadline,expectedSequence:state.market.latestSequence,
      expectedConfigVersion:state.config.configVersion,
      expectedStateVersion:state.financeMarket.stateVersion,
      vaultBalanceAtoms:balance.toString(),supportBalanceAtoms:state.supportPayment.amountAtoms,
      pmaxAtoms:pmax.toString(),targetAssetsAtoms:target.toString(),
      contributionAtoms:contribution.toString(),maxContributionAtoms:contribution.toString(),
      supportSpentAfterAtoms:(BigInt(state.financeConfig.supportSpent)+contribution).toString(),
      supportedMarketsAfter:state.financeConfig.supportedMarkets+1},
    instruction:{programAddress:instruction.programAddress,
      accountAddresses:instruction.accounts.map(x=>x.address),
      dataHex:Buffer.from(instruction.data).toString('hex')}};
}

export class FileGraduationJournal{
  constructor(path){this.path=path;}
  async read(){try{return JSON.parse(await readFile(this.path,'utf8'));}
    catch(error){if(error.code==='ENOENT')return {scope:null,pending:null};throw error;}}
  async write(value){await mkdir(dirname(this.path),{recursive:true});
    const temporary=`${this.path}.${process.pid}.tmp`;
    await writeFile(temporary,JSON.stringify(value),'utf8');await replaceJournal(temporary,this.path);}
}

export async function executeGraduation({config,runtime,journal}){
  check(runtime?.readFinalizedState && runtime?.sendInstruction &&
    runtime?.signatureStatus && journal?.read && journal?.write,'GRADUATE_RUNTIME_REQUIRED');
  const offline=await createGraduatePlan(config);
  const scope={...offline.scope,marketSeedHex:config.marketSeedHex,
    genesisHash:runtime.expectedGenesisHash??null};
  let saved=await journal.read();
  if(saved.scope)check(equal(saved.scope,scope),'GRADUATE_JOURNAL_SCOPE_MISMATCH');
  else{saved.scope=scope;await journal.write(saved);}
  const state=await runtime.readFinalizedState(offline);
  if(state.market?.phase==='INDEXED'){
    if(saved.pending?.signature){
      const status=await runtime.signatureStatus(saved.pending.signature);
      if(status==='FINALIZED')return {state:'FINALIZED',signature:saved.pending.signature};
    }
    return {state:'ALREADY_INDEXED'};
  }
  if(saved.pending){
    const status=saved.pending.signature?
      await runtime.signatureStatus(saved.pending.signature):'UNKNOWN';
    return {state:status==='FAILED'?'FAILED_TRANSACTION':'PENDING_RECONCILIATION',
      signatureStatus:status,pending:saved.pending};
  }
  const plan=await createGraduatePlan(config,state,{mode:'EXECUTE',now:runtime.now()});
  check(plan.state==='READY','GRADUATE_NOT_READY');
  saved.pending={sequence:plan.quote.expectedSequence,
    contributionAtoms:plan.quote.contributionAtoms,deadline:plan.quote.deadline,
    dataHex:plan.instruction.dataHex,signature:null};
  await journal.write(saved);
  const result=await runtime.sendInstruction(plan,{onSigned:async signature=>{
    saved.pending.signature=signature;await journal.write(saved);
  }}).catch(()=>({state:'UNKNOWN',signature:saved.pending.signature}));
  if(result?.signature)check(saved.pending.signature===result.signature,
    'GRADUATE_SIGNATURE_NOT_JOURNALED');
  const after=await runtime.readFinalizedState(offline);
  if(after.market?.phase==='INDEXED' && saved.pending.signature &&
    await runtime.signatureStatus(saved.pending.signature)==='FINALIZED')
    return {state:'FINALIZED',signature:saved.pending.signature,plan};
  return {state:result?.state==='FAILED'?'FAILED_TRANSACTION':'PENDING_RECONCILIATION',
    signature:saved.pending.signature,plan};
}

async function signerFromFile(path){
  check(path,'GRADUATE_ADMIN_KEYPAIR_REQUIRED');
  const bytes=JSON.parse(await readFile(path,'utf8'));
  check(Array.isArray(bytes) && bytes.length===64 && bytes.every(x=>
    Number.isInteger(x) && x>=0 && x<=255),'GRADUATE_KEYPAIR_INVALID');
  return kit.createKeyPairSignerFromBytes(Uint8Array.from(bytes));
}

export async function createGraduateRuntime(config,{endpoint,expectedGenesisHash,
  adminSigner,rpc=endpoint?kit.createSolanaRpc(endpoint):null,
  transport=endpoint?chain.createKitChainTransport(endpoint):null,
  now=()=>Math.floor(Date.now()/1000),wait=ms=>new Promise(done=>setTimeout(done,ms))}){
  validateConfig(config);
  check(adminSigner?.address===config.admin,'GRADUATE_ADMIN_SIGNER_MISMATCH');
  check(expectedGenesisHash && kit.isAddress(expectedGenesisHash) && rpc && transport,
    'GRADUATE_RPC_IDENTITY_REQUIRED');
  const url=new URL(endpoint??'http://localhost');
  check(['http:','https:'].includes(url.protocol),'GRADUATE_RPC_URL_INVALID');
  if(config.cluster==='localnet')check(['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname),
    'GRADUATE_LOCALNET_RPC_MUST_BE_LOOPBACK');
  const a=await addresses(config);
  let genesisChecked=false;
  async function checkGenesis(){if(genesisChecked)return;
    check(await rpc.getGenesisHash().send()===expectedGenesisHash,'GRADUATE_GENESIS_MISMATCH');
    genesisChecked=true;}
  async function token(address){
    const encoded=await transport.getFinalizedAccount(address);
    check(encoded.exists,'GRADUATE_TOKEN_ACCOUNT_MISSING');
    const data=encoded.programAddress===spl.TOKEN_PROGRAM_ADDRESS?
      spl.decodeToken(encoded).data:null;
    return {address,ownerProgramId:encoded.programAddress,finality:'finalized',
      mint:data?.mint,owner:data?.owner,state:data?.state,
      amountAtoms:data?.amount.toString()};
  }
  async function readFinalizedState(){
    await checkGenesis();
    const program=await transport.getFinalizedAccount(config.programId);
    const [core,finance,market,financeMarket]=await Promise.all([
      chain.readFinalizedConfig(transport,config.programId),
      chain.readFinalizedFinanceConfig(transport,config.programId),
      chain.readFinalizedMarket(transport,a.marketSeed,config.programId),
      chain.readFinalizedFinanceMarket(transport,a.market,config.programId)]);
    const [mintEncoded,vault,support]=await Promise.all([
      transport.getFinalizedAccount(config.paymentMint),token(a.paymentVault),token(a.supportPayment)]);
    check(mintEncoded.exists,'GRADUATE_MINT_MISSING');
    const mint=mintEncoded.programAddress===spl.TOKEN_PROGRAM_ADDRESS?
      spl.decodeMint(mintEncoded).data:null;
    const m=market.data,f=finance.data,fm=financeMarket.data;
    const sequence=m.latestSequence;
    const snapshot=sequence>0n?await chain.readFinalizedSnapshot(transport,a.market,sequence,
      config.programId):null;
    const status=x=>x===chain.DataStatus.Valid?'VALID':
      x===chain.DataStatus.Outage?'OUTAGE':
      x===chain.DataStatus.LowActivity?'LOW_ACTIVITY':'PREPARING';
    const phase=x=>x===chain.MarketPhase.Curve?'CURVE':
      x===chain.MarketPhase.Indexed?'INDEXED':'GRADUATION_WAIT';
    return {program:{address:config.programId,ownerProgramId:program.programAddress,
      executable:program.exists&&program.executable,finality:'finalized'},
      config:{address:core.address,ownerProgramId:core.programAddress,
        admin:core.data.admin,configVersion:core.data.configVersion.toString(),
        formulaVersion:Buffer.from(core.data.formulaVersion).toString('hex'),finality:'finalized'},
      financeConfig:{address:finance.address,ownerProgramId:finance.programAddress,
        admin:f.admin,paymentMint:f.paymentMint,supportedMarkets:f.supportedMarkets,
        supportSpent:f.supportSpent.toString(),finality:'finalized'},
      market:{address:market.address,ownerProgramId:market.programAddress,
        seedHex:Buffer.from(m.id).toString('hex'),phase:phase(m.phase),
        dataStatus:status(m.dataStatus),admission:m.admission.state===chain.AdmissionState.Open?'OPEN':'BLOCKED',
        queryVersion:m.queryVersion.toString(),queryHash:Buffer.from(m.queryHash).toString('hex'),
        latestSequence:sequence.toString(),latestHash:Buffer.from(m.latestHash).toString('hex'),
        latestDataThrough:m.latestDataThrough.toString(),
        latestNowQ12:option(m.latestNowQ12)?.toString()??null,
        latest7dQ12:option(m.latest7dQ12)?.toString()??null,finality:'finalized'},
      financeMarket:{address:financeMarket.address,ownerProgramId:financeMarket.programAddress,
        market:fm.market,bump:fm.bump,paymentVault:fm.paymentVault,
        stateVersion:fm.stateVersion.toString(),
        curveSold:fm.curveSold.toString(),curveReserve:fm.curveReserve.toString(),
        marketFees:fm.marketFees.toString(),proReserved:fm.proReserved.toString(),
        otherReserved:fm.otherReserved.toString(),finality:'finalized'},
      snapshot:snapshot&&{address:snapshot.address,ownerProgramId:snapshot.programAddress,
        market:snapshot.data.market,sequence:snapshot.data.sequence.toString(),
        payloadHash:Buffer.from(snapshot.data.payloadHash).toString('hex'),
        queryVersion:snapshot.data.queryVersion.toString(),
        queryHash:Buffer.from(snapshot.data.queryHash).toString('hex'),
        configVersion:snapshot.data.configVersion.toString(),
        dataStatus:status(snapshot.data.dataStatus),
        admission:snapshot.data.admission.state===chain.AdmissionState.Open?'OPEN':'BLOCKED',
        formulaVersion:Buffer.from(snapshot.data.formulaVersion).toString('hex'),
        dataThrough:snapshot.data.dataThrough.toString(),
        activityNowQ12:option(snapshot.data.activityNowQ12)?.toString()??null,
        activity7dQ12:option(snapshot.data.activity7dQ12)?.toString()??null,
        finality:'finalized'},
      paymentMint:{address:config.paymentMint,ownerProgramId:mintEncoded.programAddress,
        decimals:mint?.decimals,isInitialized:mint?.isInitialized,
        mintAuthority:option(mint?.mintAuthority),
        freezeAuthority:option(mint?.freezeAuthority),finality:'finalized'},
      paymentVault:vault,supportPayment:support};
  }
  async function signatureStatus(signature){await checkGenesis();
    const value=await transport.getSignatureStatus(signature).catch(()=>null);
    return value?.err!=null?'FAILED':value?.confirmationStatus==='finalized'?'FINALIZED':'UNKNOWN';}
  async function sendInstruction(plan,{onSigned}){
    await checkGenesis();
    check(plan.mode==='EXECUTE' && plan.state==='READY','GRADUATE_PLAN_REQUIRED');
    check(now()<=plan.quote.deadline,'GRADUATE_QUOTE_EXPIRED');
    const instruction=await chain.getGraduateInstructionAsync({market:a.market,
      snapshot:plan.accounts.snapshot,paymentMint:config.paymentMint,
      paymentVault:a.paymentVault,supportPayment:a.supportPayment,admin:adminSigner,
      expectedSequence:BigInt(plan.quote.expectedSequence),
      expectedConfigVersion:BigInt(plan.quote.expectedConfigVersion),
      expectedStateVersion:BigInt(plan.quote.expectedStateVersion),
      deadline:BigInt(plan.quote.deadline),
      maxContribution:BigInt(plan.quote.contributionAtoms)},
    {programAddress:config.programId});
    check(Buffer.from(instruction.data).toString('hex')===plan.instruction.dataHex,
      'GRADUATE_INSTRUCTION_CHANGED');
    const lifetime=await transport.getLatestBlockhash();
    check(await transport.getBlockHeight()<=lifetime.lastValidBlockHeight &&
      await transport.isBlockhashValid(lifetime.blockhash),'GRADUATE_BLOCKHASH_INVALID');
    const message=kit.appendTransactionMessageInstruction(instruction,
      kit.setTransactionMessageLifetimeUsingBlockhash({blockhash:kit.blockhash(lifetime.blockhash),
        lastValidBlockHeight:lifetime.lastValidBlockHeight},
      kit.setTransactionMessageFeePayer(config.admin,kit.createTransactionMessage({version:0}))));
    const signed=await kit.signTransactionWithSigners([adminSigner],kit.compileTransaction(message));
    check(kit.isFullySignedTransaction(signed),'GRADUATE_SIGNATURE_INCOMPLETE');
    const signature=kit.getSignatureFromTransaction(signed);
    await onSigned(signature);
    const wire=kit.getBase64Decoder().decode(kit.getTransactionEncoder().encode(signed));
    let returned;
    try{returned=await transport.sendTransaction(wire);}catch{return {state:'UNKNOWN',signature};}
    if(returned!==signature)return {state:'UNKNOWN',signature};
    for(let attempt=0;attempt<8;attempt++){
      const status=await signatureStatus(signature);
      if(status==='FAILED')return {state:'FAILED',signature};
      if(status==='FINALIZED')return {state:'FINALIZED',signature};
      if(await transport.getBlockHeight()>lifetime.lastValidBlockHeight)
        return {state:'UNKNOWN',signature};
      if(attempt<7)await wait(400);
    }
    return {state:'UNKNOWN',signature};
  }
  return {expectedGenesisHash,now,readFinalizedState,signatureStatus,sendInstruction};
}

async function main(argv=process.argv.slice(2),env=process.env){
  check(argv.every(x=>x==='--execute'),'GRADUATE_UNKNOWN_ARGUMENT');
  const config=graduateConfigFromEnv(env);
  if(!argv.includes('--execute')){
    if(!env.ANTE_UP_GRADUATE_RPC_URL){
      process.stdout.write(`${JSON.stringify(await createGraduatePlan(config),null,2)}\n`);return;
    }
    const runtime=await createGraduateRuntime(config,{endpoint:env.ANTE_UP_GRADUATE_RPC_URL,
      expectedGenesisHash:env.ANTE_UP_GRADUATE_EXPECTED_GENESIS_HASH,
      adminSigner:kit.createNoopSigner(config.admin)});
    const state=await runtime.readFinalizedState();
    process.stdout.write(`${JSON.stringify(await createGraduatePlan(config,state),null,2)}\n`);return;
  }
  check(env.ANTE_UP_GRADUATE_JOURNAL_FILE,'GRADUATE_JOURNAL_REQUIRED');
  const signer=await signerFromFile(env.ANTE_UP_GRADUATE_ADMIN_KEYPAIR_FILE);
  const runtime=await createGraduateRuntime(config,{endpoint:env.ANTE_UP_GRADUATE_RPC_URL,
    expectedGenesisHash:env.ANTE_UP_GRADUATE_EXPECTED_GENESIS_HASH,adminSigner:signer});
  const result=await executeGraduation({config,runtime,
    journal:new FileGraduationJournal(resolve(env.ANTE_UP_GRADUATE_JOURNAL_FILE))});
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{process.stderr.write(`${error.message??error}\n`);process.exitCode=1;});
