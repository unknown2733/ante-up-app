/** Financial keeper CLI. Default is read-only; --execute authorizes one on-chain instruction. */
import {readFile} from 'node:fs/promises';
import {KitFinalizedAccountReader} from '../../indexer/src/repositories.ts';
import {SqliteKeeperAttempts} from '../../keeper/src/attempts.ts';
import {advanceFinancialEpoch, planFinancialEpoch} from '../../keeper/src/flow.ts';
import {advanceEmptyLpRecovery,planEmptyLpRecovery} from '../../keeper/src/lp-recovery.ts';
import {runKeeperLoop} from '../../keeper/src/runner.ts';
import {assertSettlementJournalFile, type SettlementScope} from '../../keeper/src/candidate.ts';
import {FinalizedFinancialAccounts, FirstSliceFinancialReader} from './financial-chain.ts';
import {SqliteFinancialRegistrationStore} from './registration.ts';
import {KitFinancialEpochChain, type KeeperInstructionTransport} from './keeper-chain.ts';
import {KitKeeperInstructionTransport, loadKeeperKeypair} from './keeper-transport.ts';
import {verifyKeeperRpcIdentity} from './keeper-rpc-identity.ts';

type Options={scope:string;journal:string;rpc:string;expectedGenesisHash?:string;attempts?:string;
  publisherKeypair?:string;keeperKeypair?:string;execute:boolean;follow:boolean;intervalMs:number;maxPasses:number};
function parseArgs(args:string[]):Options {
  const values=new Map<string,string>();let execute=false,follow=false;
  for (let i=0;i<args.length;i++) {
    const key=args[i];
    if (key==='--execute') {execute=true;continue;}
    if (key==='--follow') {follow=true;continue;}
    if (!['--scope','--journal','--rpc','--expected-genesis-hash','--attempts','--publisher-keypair','--keeper-keypair',
      '--interval-seconds','--max-passes'].includes(key) ||
        !args[i+1] || args[i+1].startsWith('--') || values.has(key)) throw new Error('KEEPER_CLI_ARGUMENTS');
    values.set(key,args[++i]);
  }
  const scope=values.get('--scope'),journal=values.get('--journal'),rpc=values.get('--rpc')??process.env.ANTE_UP_RPC_URL;
  const expectedGenesisHash=values.get('--expected-genesis-hash')??process.env.ANTE_UP_KEEPER_EXPECTED_GENESIS_HASH;
  if (!scope || !journal || !rpc || !/^https?:\/\//.test(rpc)) throw new Error('KEEPER_CLI_REQUIRES_SCOPE_JOURNAL_RPC');
  if (execute && (!values.get('--attempts') || !values.get('--publisher-keypair') || !values.get('--keeper-keypair') ||
      !expectedGenesisHash)) throw new Error('KEEPER_EXECUTE_REQUIRES_ATTEMPTS_KEYPAIRS_AND_GENESIS');
  const intervalSeconds=Number(values.get('--interval-seconds')??'30');
  const maxPasses=Number(values.get('--max-passes')??(follow?'9007199254740991':'1'));
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds<1 || intervalSeconds>300 ||
      !Number.isSafeInteger(maxPasses) || maxPasses<1 || !follow && maxPasses!==1)
    throw new Error('KEEPER_CLI_BOUNDS_INVALID');
  return {scope,journal,rpc,expectedGenesisHash,attempts:values.get('--attempts'),publisherKeypair:values.get('--publisher-keypair'),
    keeperKeypair:values.get('--keeper-keypair'),execute,follow,intervalMs:intervalSeconds*1000,maxPasses};
}
async function main() {
  const options=parseArgs(process.argv.slice(2));
  await assertSettlementJournalFile(options.journal);
  const loadScope=async()=>{
    const scope=JSON.parse(await readFile(options.scope,'utf8')) as SettlementScope;
    if (!scope || (scope.cluster!=='localnet' && scope.cluster!=='devnet') || !scope.programId || !scope.marketId ||
        !scope.epoch || !scope.anchor) throw new Error('KEEPER_SCOPE_INVALID');
    return scope;
  };
  const initialScope=await loadScope();
  if (options.expectedGenesisHash) await verifyKeeperRpcIdentity({cluster:initialScope.cluster,endpoint:options.rpc,
    expectedGenesisHash:options.expectedGenesisHash});
  const accounts=new KitFinalizedAccountReader(options.rpc);
  const registrations=new SqliteFinancialRegistrationStore(':memory:');
  let attempts:SqliteKeeperAttempts|undefined;
  try {
    let transport:KeeperInstructionTransport;
    if (options.execute) {
      const [publisher,keeper]=await Promise.all([loadKeeperKeypair(options.publisherKeypair!),
        loadKeeperKeypair(options.keeperKeypair!)]);
      transport=new KitKeeperInstructionTransport({endpoint:options.rpc,programId:initialScope.programId,publisher,keeper});
    } else {
      transport={publisherAddress:'',keeperAddress:'',send:async()=>{throw new Error('KEEPER_PLAN_ONLY');},
        signatureStatus:async()=>{throw new Error('KEEPER_PLAN_ONLY');}};
    }
    if (options.execute) attempts=new SqliteKeeperAttempts(options.attempts!);
    const pass=async()=>{
      const scope=await loadScope();
      if (scope.cluster!==initialScope.cluster || scope.programId!==initialScope.programId ||
          scope.marketId!==initialScope.marketId) throw new Error('KEEPER_SCOPE_ROTATION_MISMATCH');
      if (options.execute) await verifyKeeperRpcIdentity({cluster:scope.cluster,endpoint:options.rpc,
        expectedGenesisHash:options.expectedGenesisHash!});
      const state=new FinalizedFinancialAccounts({cluster:scope.cluster,programId:scope.programId,accounts});
      const reader=new FirstSliceFinancialReader(state,registrations);
      const chain=new KitFinancialEpochChain(state,reader,transport,scope),now=Math.floor(Date.now()/1000);
      const empty=await chain.readEmptyWindow(scope.marketId);
      if (empty.cycle!==scope.epoch) throw new Error('KEEPER_SCOPE_CYCLE_MISMATCH');
      const recovery=planEmptyLpRecovery(empty,scope.marketId,now);
      if (recovery.state==='ready') {
        const progress=options.execute?await advanceEmptyLpRecovery({marketId:scope.marketId,chain,attempts:attempts!,now}):
          {state:'ready',signature:null};
        return {mode:options.execute?'execute':'plan',marketId:scope.marketId,epoch:scope.epoch,
          action:'RECOVER_LP_WINDOW',...progress};
      }
      if (!options.execute) {
        const plan=await planFinancialEpoch({journalPath:options.journal,scope,chain,now});
        return {mode:'plan',marketId:scope.marketId,epoch:scope.epoch,state:plan.state,
          action:plan.action,entity:plan.entity,candidateHash:plan.candidate?Buffer.from(plan.candidate.candidateHash).toString('hex'):null,
          openPositionCount:plan.finalized?.openPositionCount??null};
      }
      const progress=await advanceFinancialEpoch({journalPath:options.journal,scope,chain,attempts:attempts!,now});
      return {mode:'execute',marketId:scope.marketId,epoch:scope.epoch,...progress};
    };
    if (!options.follow) {
      const result=await pass();process.stdout.write(JSON.stringify(result)+'\n');
      if (result.state==='unknown') process.exitCode=2;
      return;
    }
    const controller=new AbortController();
    process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
    await runKeeperLoop({intervalMs:options.intervalMs,maxPasses:options.maxPasses,maxConsecutiveErrors:5,
      signal:controller.signal,pass,report:event=>process.stdout.write(JSON.stringify(event)+'\n')});
  } finally {attempts?.close();registrations.close();}
}
main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
