import { createRequire } from 'node:module';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import * as chain from '../clients/chain/dist/index.js';

// Resolve the exact SPL SDK pinned by the chain client.
const chainRequire=createRequire(new URL('../clients/chain/package.json',import.meta.url));
const spl=chainRequire('@solana-program/token');
const kit=chainRequire('@solana/kit');
const check=(ok,code='INVALID_BOOTSTRAP_INPUT')=>{if(!ok)throw new Error(code);};
const uint=x=>typeof x==='string' && /^(0|[1-9][0-9]*)$/.test(x) &&
  BigInt(x)<=18_446_744_073_709_551_615n;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const SUPPORT_ATOMS='50000000000'; // 50,000 tUSD at six decimals.
const FAUCET_ATOMS='1000000000'; // Configurable technical default: 1,000 tUSD.
const COOLDOWN_SECONDS='86400';
const STAGES=['CREATE_MINT','CREATE_TREASURY_ATA','MINT_SUPPORT',
  'TRANSFER_MINT_AUTHORITY','INITIALIZE_FINANCE'];

export function bootstrapConfigFromEnv(env=process.env) {
  return {cluster:env.ANTE_UP_BOOTSTRAP_CLUSTER,
    programId:env.ANTE_UP_BOOTSTRAP_PROGRAM_ID,
    admin:env.ANTE_UP_BOOTSTRAP_ADMIN,
    paymentMint:env.ANTE_UP_BOOTSTRAP_PAYMENT_MINT,
    faucetAmountAtoms:env.ANTE_UP_BOOTSTRAP_FAUCET_AMOUNT_ATOMS??FAUCET_ATOMS,
    faucetCooldownSeconds:env.ANTE_UP_BOOTSTRAP_FAUCET_COOLDOWN_SECONDS??COOLDOWN_SECONDS,
    faucetGlobalCapAtoms:env.ANTE_UP_BOOTSTRAP_FAUCET_GLOBAL_CAP_ATOMS};
}

function validateConfig(config) {
  check(['localnet','devnet'].includes(config.cluster),'CLUSTER_MUST_BE_TESTNET');
  for(const key of ['programId','admin','paymentMint'])
    check(kit.isAddress(config[key]),`INVALID_${key.toUpperCase()}`);
  check(config.admin!==config.paymentMint && config.paymentMint!==config.programId &&
    config.admin!==config.programId,'BOOTSTRAP_ADDRESS_COLLISION');
  check(uint(config.faucetAmountAtoms) && BigInt(config.faucetAmountAtoms)>0n &&
    uint(config.faucetCooldownSeconds) && BigInt(config.faucetCooldownSeconds)>=86400n &&
    uint(config.faucetGlobalCapAtoms) &&
    BigInt(config.faucetGlobalCapAtoms)>=BigInt(config.faucetAmountAtoms),'INVALID_FAUCET_CONFIG');
}

async function addresses(config) {
  const [configPda]=await chain.findConfigPda({programAddress:config.programId});
  const [financeConfig]=await chain.findFinanceConfigPda({programAddress:config.programId});
  const [treasuryAta]=await spl.findAssociatedTokenPda({mint:config.paymentMint,
    owner:config.admin,tokenProgram:spl.TOKEN_PROGRAM_ADDRESS});
  return {configPda:String(configPda),financeConfig:String(financeConfig),
    treasuryAta:String(treasuryAta)};
}

function finalized(value,code){check(value.finality==='finalized',code);}
function validatedState(config,derived,state) {
  if(state===null)return null;
  check(state && typeof state==='object','FINALIZED_STATE_REQUIRED');
  const program=state.program;
  check(program?.address===config.programId && program.executable===true,
    'FINANCE_PROGRAM_NOT_DEPLOYED');
  finalized(program,'PROGRAM_NOT_FINALIZED');
  const core=state.coreConfig;
  check(core?.ownerProgramId===config.programId && core.admin===config.admin &&
    core.address===derived.configPda,'CORE_CONFIG_REQUIRED');
  finalized(core,'CORE_CONFIG_NOT_FINALIZED');
  const mint=state.mint??null,treasury=state.treasury??null,finance=state.financeConfig??null;
  if(mint){
    finalized(mint,'MINT_NOT_FINALIZED');
    check(mint.address===config.paymentMint && mint.ownerProgramId===spl.TOKEN_PROGRAM_ADDRESS &&
      mint.decimals===6 && mint.isInitialized===true &&
      mint.freezeAuthority===null && uint(mint.supplyAtoms),
      'MINT_IDENTITY_MISMATCH');
    check(mint.mintAuthority===config.admin || mint.mintAuthority===derived.financeConfig,
      'MINT_AUTHORITY_MISMATCH');
  }
  if(treasury){
    finalized(treasury,'TREASURY_NOT_FINALIZED');
    check(treasury.address===derived.treasuryAta &&
      treasury.ownerProgramId===spl.TOKEN_PROGRAM_ADDRESS &&
      treasury.mint===config.paymentMint && treasury.owner===config.admin &&
      treasury.state===spl.AccountState.Initialized &&
      treasury.delegate===null && treasury.closeAuthority===null &&
      uint(treasury.amountAtoms),'TREASURY_IDENTITY_MISMATCH');
  }
  if(finance){
    finalized(finance,'FINANCE_NOT_FINALIZED');
    check(finance.address===derived.financeConfig && finance.ownerProgramId===config.programId &&
      finance.admin===config.admin && finance.paymentMint===config.paymentMint &&
      finance.protocolTreasury===derived.treasuryAta &&
      finance.faucetAmountAtoms===config.faucetAmountAtoms &&
      finance.faucetCooldownSeconds===config.faucetCooldownSeconds &&
      finance.faucetGlobalCapAtoms===config.faucetGlobalCapAtoms &&
      uint(finance.faucetMintedAtoms),'FINANCE_CONFIG_MISMATCH');
    check(mint && treasury && mint.mintAuthority===derived.financeConfig,
      'FINANCE_ACCOUNT_INCOMPLETE');
  }
  return {program,core,mint,treasury,finance};
}

function nextStep(config,derived,state) {
  if(state===null)return {kind:'UNVERIFIED',reason:'Finalized account reads required before execution'};
  const {mint,treasury,finance}=state;
  if(finance)return null;
  if(!mint){check(!treasury,'TREASURY_WITHOUT_MINT');
    return {kind:'CREATE_MINT',paymentMint:config.paymentMint,decimals:6,
      mintAuthority:config.admin,freezeAuthority:null};}
  if(!treasury)return {kind:'CREATE_TREASURY_ATA',treasuryAta:derived.treasuryAta,
    owner:config.admin,mint:config.paymentMint};
  const supply=BigInt(mint.supplyAtoms),balance=BigInt(treasury.amountAtoms),target=BigInt(SUPPORT_ATOMS);
  check(supply===balance && balance<=target,'BOOTSTRAP_SUPPLY_DIVERGED');
  if(balance<target){
    check(mint.mintAuthority===config.admin,'SUPPORT_MINT_AUTHORITY_REQUIRED');
    return {kind:'MINT_SUPPORT',amountAtoms:(target-balance).toString(),treasuryAta:derived.treasuryAta};
  }
  if(mint.mintAuthority===config.admin)
    return {kind:'TRANSFER_MINT_AUTHORITY',paymentMint:config.paymentMint,
      from:config.admin,to:derived.financeConfig};
  return {kind:'INITIALIZE_FINANCE',financeConfig:derived.financeConfig,
    paymentMint:config.paymentMint,treasuryAta:derived.treasuryAta,
    faucetAmountAtoms:config.faucetAmountAtoms,
    faucetCooldownSeconds:config.faucetCooldownSeconds,
    faucetGlobalCapAtoms:config.faucetGlobalCapAtoms};
}

export async function createBootstrapPlan(config,state=null,{mode='DRY_RUN'}={}) {
  validateConfig(config);
  check(['DRY_RUN','EXECUTE'].includes(mode),'INVALID_BOOTSTRAP_MODE');
  const derived=await addresses(config);
  const verified=validatedState(config,derived,state);
  const next=nextStep(config,derived,verified);
  const instruction=await chain.getInitializeFinanceInstructionAsync({
    paymentMint:config.paymentMint,protocolTreasury:derived.treasuryAta,
    admin:kit.createNoopSigner(config.admin),faucetAmount:BigInt(config.faucetAmountAtoms),
    faucetCooldown:BigInt(config.faucetCooldownSeconds),
    faucetTotalLimit:BigInt(config.faucetGlobalCapAtoms),
  },{programAddress:config.programId});
  check(instruction.accounts[1].address===derived.financeConfig &&
    instruction.accounts[2].address===config.paymentMint &&
    instruction.accounts[3].address===derived.treasuryAta &&
    instruction.accounts[4].address===config.admin,'INITIALIZE_INSTRUCTION_MISMATCH');
  return {kind:'FINANCE_BOOTSTRAP_PLAN',mode,scope:{cluster:config.cluster,
    programId:config.programId,admin:config.admin,paymentMint:config.paymentMint},
    configPda:derived.configPda,financeConfig:derived.financeConfig,treasuryAta:derived.treasuryAta,
    tokenProgram:spl.TOKEN_PROGRAM_ADDRESS,associatedTokenProgram:spl.ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    decimals:6,supportAtoms:SUPPORT_ATOMS,
    faucet:{amountAtoms:config.faucetAmountAtoms,cooldownSeconds:config.faucetCooldownSeconds,
      globalCapAtoms:config.faucetGlobalCapAtoms},
    order:STAGES,next,completed:next===null,
    initializeFinance:{programAddress:instruction.programAddress,
      accountAddresses:instruction.accounts.map(a=>a.address),
      dataHex:Buffer.from(instruction.data).toString('hex')}};
}

export class FileBootstrapJournal {
  constructor(path){this.path=path;}
  async read(){try{return JSON.parse(await readFile(this.path,'utf8'));}
    catch(e){if(e.code==='ENOENT')return {scope:null,pending:null,completed:[]};throw e;}}
  async write(value){await mkdir(dirname(this.path),{recursive:true});
    const temp=`${this.path}.${process.pid}.tmp`;
    await writeFile(temp,JSON.stringify(value),'utf8');await rename(temp,this.path);}
}

// The runtime supplies finalized reads and SPL/Kit sends. A pending write is
// never repeated automatically after an uncertain response or process restart.
export async function executeBootstrap({config,runtime,journal}) {
  check(runtime?.readFinalizedState && runtime?.executeStep && journal?.read && journal?.write,
    'BOOTSTRAP_RUNTIME_REQUIRED');
  const base=await createBootstrapPlan(config,null,{mode:'EXECUTE'});
  let saved=await journal.read();
  const scope={...base.scope,faucet:base.faucet,supportAtoms:base.supportAtoms,
    genesisHash:runtime.expectedGenesisHash??null};
  if(saved.scope)check(same(saved.scope,scope),'BOOTSTRAP_JOURNAL_SCOPE_MISMATCH');
  else {saved.scope=scope;await journal.write(saved);}
  for(let attempt=0;attempt<STAGES.length+1;attempt++){
    const state=await runtime.readFinalizedState(base);
    const plan=await createBootstrapPlan(config,state,{mode:'EXECUTE'});
    if(saved.pending){
      if(plan.next?.kind===saved.pending.kind){
        const status=saved.pending.signature && runtime.reconcilePending
          ? await runtime.reconcilePending(saved.pending) : 'UNKNOWN';
        return {state:status==='FAILED'?'FAILED_TRANSACTION':'PENDING_RECONCILIATION',
          step:saved.pending,signatureStatus:status,plan};
      } else {
      saved.completed=[...new Set([...saved.completed,saved.pending.kind])];
      saved.pending=null;await journal.write(saved);
      }
    }
    if(plan.completed)return {state:'COMPLETE',plan};
    check(plan.next?.kind && plan.next.kind!=='UNVERIFIED','FINALIZED_STATE_REQUIRED');
    saved.pending={kind:plan.next.kind,args:plan.next,signature:null};
    await journal.write(saved);
    try{
      const sent=await runtime.executeStep(plan.next,{plan,config,
        onSigned:async signature=>{saved.pending.signature=signature;await journal.write(saved);}});
      if(sent?.signature){
        check(!saved.pending.signature || saved.pending.signature===sent.signature,
          'BOOTSTRAP_SIGNATURE_MISMATCH');
        saved.pending.signature=sent.signature;await journal.write(saved);
      }
    }catch(e){
      const after=await createBootstrapPlan(config,await runtime.readFinalizedState(base),
        {mode:'EXECUTE'});
      if(after.next?.kind===plan.next.kind)
        return {state:'PENDING_RECONCILIATION',step:saved.pending,error:String(e.message??e),plan:after};
    }
  }
  throw new Error('BOOTSTRAP_STEP_LIMIT');
}

async function main(argv=process.argv.slice(2),env=process.env){
  check(argv.every(arg=>arg==='--execute'),'UNKNOWN_BOOTSTRAP_ARGUMENT');
  const config=bootstrapConfigFromEnv(env);
  if(!argv.includes('--execute')){
    process.stdout.write(`${JSON.stringify(await createBootstrapPlan(config),null,2)}\n`);
    return;
  }
  const journalPath=env.ANTE_UP_BOOTSTRAP_JOURNAL_FILE;
  check(journalPath,'BOOTSTRAP_JOURNAL_FILE_REQUIRED');
  const modulePath=env.ANTE_UP_BOOTSTRAP_RUNTIME_MODULE;
  const runtime=modulePath ? await import(pathToFileURL(resolve(modulePath)).href)
    : await (await import('./bootstrap-finance-runtime.mjs')).createFinanceBootstrapRuntimeFromEnv(config,env);
  const result=await executeBootstrap({config,runtime,journal:new FileBootstrapJournal(resolve(journalPath))});
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(e=>{process.stderr.write(`${e.message??e}\n`);process.exitCode=1;});
