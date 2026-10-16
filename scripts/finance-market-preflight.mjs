/** Read-only Devnet preflight. Opens no signer and creates no transaction. */
import {readFile,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as chain from '../clients/chain/dist/index.js';
import {KitFinalizedAccountReader} from '../services/indexer/src/repositories.ts';
import {FinalizedFinancialAccounts} from '../services/api/src/financial-chain.ts';
import {FirstSliceFinancialReader} from '../services/api/src/financial-chain.ts';
import {SqliteFinancialRegistrationStore} from '../services/api/src/registration.ts';
import {KitFinancialEpochChain} from '../services/api/src/keeper-chain.ts';
import {readFinalizedMarketReadiness} from '../services/api/src/keeper-readiness.ts';
import {readFrozenSettlement} from '../services/keeper/src/candidate.ts';

const kit=createRequire(new URL('../clients/chain/package.json',import.meta.url))('@solana/kit');
const genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const safe=e=>String(e?.message??e).replace(/https?:\/\/[^\s"'<>]+/g,'[RPC_URL_REDACTED]').slice(0,250);
const exists=async path=>{if(!path)return false;try{return (await stat(path)).isFile();}catch{return false;}};
async function main(){
  const [marketId]=process.argv.slice(2);
  if(process.argv.length!==3 || !kit.isAddress(marketId))throw Error('MARKET_ADDRESS_REQUIRED');
  const env=process.env;
  if(!env.ANTE_UP_RPC_URL_FILE || !await exists(env.ANTE_UP_RPC_URL_FILE))throw Error('RPC_FILE_REQUIRED');
  const endpoint=(await readFile(env.ANTE_UP_RPC_URL_FILE,'utf8')).trim();
  if(!/^https?:\/\//.test(endpoint))throw Error('RPC_URL_INVALID');
  const rpc=kit.createSolanaRpc(endpoint);
  if(await rpc.getGenesisHash().send()!==genesis)throw Error('DEVNET_GENESIS_MISMATCH');
  const transport=chain.createKitChainTransport(endpoint);
  const clock=await transport.getFinalizedAccount(kit.address('SysvarC1ock11111111111111111111111111111111'));
  if(!clock.exists)throw Error('FINALIZED_CLOCK_UNAVAILABLE');
  const chainNow=Number(Buffer.from(clock.data).readBigInt64LE(32));
  const state=new FinalizedFinancialAccounts({cluster:'devnet',programId:String(chain.ANTE_UP_PROGRAM_ADDRESS),
    accounts:new KitFinalizedAccountReader(endpoint)});
  const m=await state.market(marketId);
  let provenance='UNKNOWN';
  if(await exists(env.ANTE_UP_FINANCE_SOURCE_ATTESTATION)){
    const source=JSON.parse(await readFile(env.ANTE_UP_FINANCE_SOURCE_ATTESTATION,'utf8'));
    if(source.kind==='OBSERVED' && source.cluster==='devnet' && source.programId===state.options.programId &&
        source.marketId===marketId && source.queryHash===Buffer.from(m.queryHash).toString('hex') &&
        source.source==='X_COUNTS' && source.synthetic!==true)provenance='OBSERVED';
  }
  let scope=null,scopeMatches=false,candidateFrozen=false;
  if(await exists(env.ANTE_UP_KEEPER_SCOPE)){
    scope=JSON.parse(await readFile(env.ANTE_UP_KEEPER_SCOPE,'utf8'));
    const fm=await state.financeMarket(marketId),config=await state.config();
    scopeMatches=scope.cluster==='devnet' && scope.programId===state.options.programId &&
      scope.marketId===marketId && scope.epoch===fm.currentCycle.toString() &&
      scope.maturityAt===Number(fm.currentMaturity) && scope.queryHash===Buffer.from(m.queryHash).toString('hex') &&
      scope.queryVersion===m.queryVersion.toString() && scope.configVersion===config.configVersion.toString() &&
      scope.anchor?.graduationPriceAtoms===fm.anchorPg.toString() &&
      scope.anchor?.graduationNowQ12===fm.anchorSg.toString() &&
      scope.anchor?.graduation7dQ12===fm.anchorDg.toString() &&
      scope.anchor?.maxPriceAtoms===fm.pmax.toString();
    if(scopeMatches && fm.currentMaturity>0n){
      const registrations=new SqliteFinancialRegistrationStore(':memory:');
      try {
        const reader=new FirstSliceFinancialReader(state,registrations,()=>chainNow);
        const noSigner={publisherAddress:'',keeperAddress:'',send:async()=>{throw Error('READ_ONLY');},
          signatureStatus:async()=>{throw Error('READ_ONLY');}};
        const epoch=new KitFinancialEpochChain(state,reader,noSigner,scope);
        await epoch.read(scope); // checks first position opening, complete enumeration and scope identity
      } catch {scopeMatches=false;} finally {registrations.close();}
    }
    if(scopeMatches && await exists(env.ANTE_UP_KEEPER_JOURNAL))
      candidateFrozen=!!await readFrozenSettlement(env.ANTE_UP_KEEPER_JOURNAL,scope);
  }
  const keeper={scopePresent:scope!==null,scopeMatches,publisherKeyPresent:await exists(env.ANTE_UP_PUBLISHER_KEYPAIR_FILE),
    keeperKeyPresent:await exists(env.ANTE_UP_KEEPER_KEYPAIR_FILE),
    attemptsStorePresent:await exists(env.ANTE_UP_KEEPER_ATTEMPTS),candidateFrozen};
  const supportPaymentAddress=env.ANTE_UP_FINANCE_SUPPORT_PAYMENT_ADDRESS;
  if(supportPaymentAddress && !kit.isAddress(supportPaymentAddress))throw Error('SUPPORT_PAYMENT_ADDRESS_INVALID');
  const report=await readFinalizedMarketReadiness({state,marketId,chainNow,provenance,keeper,supportPaymentAddress});
  console.log(JSON.stringify({...report,provenanceAttestation:provenance==='OBSERVED'?'OPERATOR_FILE_MATCHED':'MISSING_OR_MISMATCHED'},null,2));
  if(report.status!=='READY_FOR_REVIEW')process.exitCode=2;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(e=>{console.error(safe(e));process.exitCode=1;});
