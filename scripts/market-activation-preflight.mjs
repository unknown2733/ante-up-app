// Read-only Devnet market activation snapshot. No signer, paid source call, or transaction.
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as chain from '../clients/chain/dist/index.js';
import {KitFinalizedAccountReader} from '../services/indexer/src/repositories.ts';
import {FinalizedFinancialAccounts} from '../services/api/src/financial-chain.ts';
import {validatePaidXRegistry} from './paid-x-approvals.mjs';

const kit=createRequire(new URL('../clients/chain/package.json',import.meta.url))('@solana/kit');
const CORRECT_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const UNIT=1_000_000n,CURVE_CAP=1_000n*UNIT,MIN_RESERVE=1_100n*UNIT;
const safe=error=>String(error?.message??error).replace(/https?:\/\/[^\s"'<>]+/g,'[RPC_URL_REDACTED]').slice(0,180);

export async function readActivation({marketId,endpoint,approvalPath}) {
  if(!kit.isAddress(marketId))throw Error('MARKET_ADDRESS_REQUIRED');
  if(await kit.createSolanaRpc(endpoint).getGenesisHash().send()!==CORRECT_GENESIS)
    throw Error('DEVNET_GENESIS_MISMATCH');
  const state=new FinalizedFinancialAccounts({cluster:'devnet',
    programId:String(chain.ANTE_UP_PROGRAM_ADDRESS),
    accounts:new KitFinalizedAccountReader(endpoint)});
  const [market,finance]=await Promise.all([state.market(marketId),state.financeMarket(marketId)]);
  const latestSequence=market.latestSequence;
  const snapshot=latestSequence>0n?await state.snapshot(marketId,latestSequence):null;
  let paidXApproval='NOT_CHECKED';
  if(approvalPath){
    const registry=JSON.parse(await readFile(approvalPath,'utf8'));
    validatePaidXRegistry(registry);
    const entry=registry.markets.find(item=>item.marketId===marketId);
    paidXApproval=entry &&
      entry.seedHex===Buffer.from(market.id).toString('hex') &&
      entry.queryHash===Buffer.from(market.queryHash).toString('hex') &&
      entry.queryVersion===market.queryVersion.toString()?'APPROVED':'NOT_APPROVED';
  }
  const sold=finance.curveSold,reserve=finance.curveReserve;
  return {
    marketId,cluster:'devnet',readOnly:true,
    phase:chain.MarketPhase[market.phase],dataStatus:chain.DataStatus[market.dataStatus],
    admission:chain.AdmissionState[market.admission.state],
    paidXApproval,latestSequence:latestSequence.toString(),snapshotPresent:!!snapshot,
    curveSoldAtoms:sold.toString(),curveRemainingAtoms:(sold<CURVE_CAP?CURVE_CAP-sold:0n).toString(),
    curveReserveAtoms:reserve.toString(),
    reserveShortfallAtoms:(reserve<MIN_RESERVE?MIN_RESERVE-reserve:0n).toString(),
    preliminaryGraduationGate:{
      curveComplete:sold===CURVE_CAP&&reserve>=MIN_RESERVE,
      observationPublished:latestSequence>0n&&!!snapshot,
      dataOpen:market.dataStatus===chain.DataStatus.Valid &&
        market.admission.state===chain.AdmissionState.Open,
      paidXApproved:paidXApproval==='APPROVED'
    },
    note:'A complete graduation plan still checks source freshness, support balance, liability, and on-chain account identities.'
  };
}

async function main(){
  const [marketId]=process.argv.slice(2);
  if(process.argv.length!==3||!process.env.ANTE_UP_RPC_URL_FILE)
    throw Error('MARKET_PREFLIGHT_ARGS_INVALID');
  const endpoint=(await readFile(process.env.ANTE_UP_RPC_URL_FILE,'utf8')).trim();
  const report=await readActivation({marketId,endpoint,
    approvalPath:process.env.ANTE_UP_APPROVED_X_MARKETS_PATH});
  console.log(JSON.stringify(report));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{console.error(safe(error));process.exitCode=1;});
