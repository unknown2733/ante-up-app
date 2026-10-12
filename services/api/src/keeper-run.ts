/** Financial keeper CLI. Default is read-only; --execute authorizes one on-chain instruction. */
import {readFile} from 'node:fs/promises';
import {KitFinalizedAccountReader} from '../../indexer/src/repositories.ts';
import {SqliteKeeperAttempts} from '../../keeper/src/attempts.ts';
import {advanceFinancialEpoch, planFinancialEpoch} from '../../keeper/src/flow.ts';
import type {SettlementScope} from '../../keeper/src/candidate.ts';
import {FinalizedFinancialAccounts, FirstSliceFinancialReader} from './financial-chain.ts';
import {SqliteFinancialRegistrationStore} from './registration.ts';
import {KitFinancialEpochChain, type KeeperInstructionTransport} from './keeper-chain.ts';
import {KitKeeperInstructionTransport, loadKeeperKeypair} from './keeper-transport.ts';
import {verifyKeeperRpcIdentity} from './keeper-rpc-identity.ts';

type Options={scope:string;journal:string;rpc:string;expectedGenesisHash?:string;attempts?:string;
  publisherKeypair?:string;keeperKeypair?:string;execute:boolean};
function parseArgs(args:string[]):Options {
  const values=new Map<string,string>();let execute=false;
  for (let i=0;i<args.length;i++) {
    const key=args[i];
    if (key==='--execute') {execute=true;continue;}
    if (!['--scope','--journal','--rpc','--expected-genesis-hash','--attempts','--publisher-keypair','--keeper-keypair'].includes(key) ||
        !args[i+1] || args[i+1].startsWith('--') || values.has(key)) throw new Error('KEEPER_CLI_ARGUMENTS');
    values.set(key,args[++i]);
  }
  const scope=values.get('--scope'),journal=values.get('--journal'),rpc=values.get('--rpc')??process.env.ANTE_UP_RPC_URL;
  const expectedGenesisHash=values.get('--expected-genesis-hash')??process.env.ANTE_UP_KEEPER_EXPECTED_GENESIS_HASH;
  if (!scope || !journal || !rpc || !/^https?:\/\//.test(rpc)) throw new Error('KEEPER_CLI_REQUIRES_SCOPE_JOURNAL_RPC');
  if (execute && (!values.get('--attempts') || !values.get('--publisher-keypair') || !values.get('--keeper-keypair') ||
      !expectedGenesisHash)) throw new Error('KEEPER_EXECUTE_REQUIRES_ATTEMPTS_KEYPAIRS_AND_GENESIS');
  return {scope,journal,rpc,expectedGenesisHash,attempts:values.get('--attempts'),publisherKeypair:values.get('--publisher-keypair'),
    keeperKeypair:values.get('--keeper-keypair'),execute};
}
async function main() {
  const options=parseArgs(process.argv.slice(2));
  const scope=JSON.parse(await readFile(options.scope,'utf8')) as SettlementScope;
  if (!scope || (scope.cluster!=='localnet' && scope.cluster!=='devnet') || !scope.programId || !scope.marketId ||
      !scope.epoch || !scope.anchor) throw new Error('KEEPER_SCOPE_INVALID');
  if (options.expectedGenesisHash) await verifyKeeperRpcIdentity({cluster:scope.cluster,endpoint:options.rpc,
    expectedGenesisHash:options.expectedGenesisHash});
  const accounts=new KitFinalizedAccountReader(options.rpc);
  const state=new FinalizedFinancialAccounts({cluster:scope.cluster,programId:scope.programId,accounts});
  const registrations=new SqliteFinancialRegistrationStore(':memory:');
  let attempts:SqliteKeeperAttempts|undefined;
  try {
    const reader=new FirstSliceFinancialReader(state,registrations);
    let transport:KeeperInstructionTransport;
    if (options.execute) {
      const [publisher,keeper]=await Promise.all([loadKeeperKeypair(options.publisherKeypair!),
        loadKeeperKeypair(options.keeperKeypair!)]);
      transport=new KitKeeperInstructionTransport({endpoint:options.rpc,programId:scope.programId,publisher,keeper});
    } else {
      transport={publisherAddress:'',keeperAddress:'',send:async()=>{throw new Error('KEEPER_PLAN_ONLY');},
        signatureStatus:async()=>{throw new Error('KEEPER_PLAN_ONLY');}};
    }
    const chain=new KitFinancialEpochChain(state,reader,transport,scope),now=Math.floor(Date.now()/1000);
    if (!options.execute) {
      const plan=await planFinancialEpoch({journalPath:options.journal,scope,chain,now});
      process.stdout.write(JSON.stringify({mode:'plan',marketId:scope.marketId,epoch:scope.epoch,state:plan.state,
        action:plan.action,entity:plan.entity,candidateHash:plan.candidate?Buffer.from(plan.candidate.candidateHash).toString('hex'):null,
        openPositionCount:plan.finalized?.openPositionCount??null})+'\n');
      return;
    }
    attempts=new SqliteKeeperAttempts(options.attempts!);
    const progress=await advanceFinancialEpoch({journalPath:options.journal,scope,chain,attempts,now});
    process.stdout.write(JSON.stringify({mode:'execute',marketId:scope.marketId,epoch:scope.epoch,...progress})+'\n');
    if (progress.state==='unknown') process.exitCode=2;
  } finally {attempts?.close();registrations.close();}
}
main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
