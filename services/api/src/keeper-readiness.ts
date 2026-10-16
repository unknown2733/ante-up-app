import {address,type ReadonlyUint8Array} from '@solana/kit';
import {AdmissionState,DataStatus,MarketPhase,findFinanceMarketPda} from '../../../clients/chain/dist/index.js';
import {FinalizedFinancialAccounts} from './financial-chain.ts';
import {evaluateFinanceMarketReadiness,type FinanceMarketFacts} from '../../keeper/src/market-readiness.ts';

const hex=(v:ReadonlyUint8Array)=>Buffer.from(v).toString('hex');
const phase=['CURVE','GRADUATION_WAIT','INDEXED'] as const;
const data=['PREPARING','VALID','LOW_ACTIVITY','OUTAGE'] as const;
const admission=['BLOCKED','RECOVERING','OPEN'] as const;

/** Reads finalized program/token accounts only. Caller supplies verified chain clock and provenance. */
export async function readFinalizedMarketReadiness(input:{state:FinalizedFinancialAccounts;marketId:string;
  chainNow:number;provenance:FinanceMarketFacts['provenance'];keeper:FinanceMarketFacts['keeper'];
  supportPaymentAddress?:string}):
  Promise<ReturnType<typeof evaluateFinanceMarketReadiness>> {
  const {state,marketId}=input,programAddress=address(state.options.programId);
  const [m,fm,fc,core]=await Promise.all([state.market(marketId),state.financeMarket(marketId),
    state.financeConfig(),state.config()]);
  const [financeAddress]=await findFinanceMarketPda({market:address(marketId)},{programAddress});
  const [vault,supportPayment]=await Promise.all([
    state.tokenAt(String(fm.paymentVault),String(fc.paymentMint),String(financeAddress)),
    input.supportPaymentAddress?
      state.tokenAt(input.supportPaymentAddress,String(fc.paymentMint),String(fc.admin)):Promise.resolve(null)]);
  const snapshot=m.latestSequence>0n?await state.snapshot(marketId,m.latestSequence):null;
  const facts:FinanceMarketFacts={finality:'finalized',cluster:state.options.cluster,marketId,
    programId:state.options.programId,chainNow:input.chainNow,provenance:input.provenance,
    phase:phase[m.phase]??'GRADUATION_WAIT',dataStatus:data[m.dataStatus]??'OUTAGE',
    admission:admission[m.admission.state]??'BLOCKED',latestSequence:m.latestSequence.toString(),
    latestDataThrough:Number(m.latestDataThrough),queryHash:hex(m.queryHash),queryVersion:m.queryVersion.toString(),
    latestHash:hex(m.latestHash),snapshot:snapshot?{sequence:snapshot.sequence.toString(),
      payloadHash:hex(snapshot.payloadHash),queryHash:hex(snapshot.queryHash),queryVersion:snapshot.queryVersion.toString()}:null,
    activityNowQ12:m.latestNowQ12.__option==='Some'?m.latestNowQ12.value.toString():null,
    activity7dQ12:m.latest7dQ12.__option==='Some'?m.latest7dQ12.value.toString():null,
    finance:{curveSold:fm.curveSold.toString(),curveReserve:fm.curveReserve.toString(),
      marketFees:fm.marketFees.toString(),assets:vault.amount.toString(),externalQ:fm.externalQ.toString(),
      anchorPg:fm.anchorPg.toString(),anchorSg:fm.anchorSg.toString(),anchorDg:fm.anchorDg.toString(),
      pmax:fm.pmax.toString(),proReserved:fm.proReserved.toString(),otherReserved:fm.otherReserved.toString(),
      openPositions:fm.openPositions,totalShares:fm.totalShares.toString(),lockedShares:fm.lockedShares.toString(),
      currentCycle:fm.currentCycle.toString(),currentMaturity:Number(fm.currentMaturity),
      lpWindowStart:Number(fm.lpWindowStart),lpWindowEnd:Number(fm.lpWindowEnd),
      proReopenAt:Number(fm.proReopenAt),lastLpMaturity:Number(fm.lastLpMaturity),
      lpGeneration:fm.lpGeneration.toString(),validityGeneration:m.validityGeneration.toString()},
    support:{supportedMarkets:fc.supportedMarkets,supportSpent:fc.supportSpent.toString(),
      supportPaymentBalance:supportPayment?.amount.toString()??null},keeper:input.keeper};
  if(String(core.admin)!==String(fc.admin))throw new Error('FINANCE_READINESS_ADMIN_MISMATCH');
  return evaluateFinanceMarketReadiness(facts);
}
