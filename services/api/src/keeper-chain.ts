import { address, createNoopSigner, type Instruction, type ReadonlyUint8Array } from '@solana/kit';
import { PRO_POSITION_DISCRIMINATOR, PositionState, SettlementMode, MarketPhase, DataStatus, AdmissionState,
  getProPositionDecoder, getAcceptSettlementInstructionAsync, getSettleProInstructionAsync,
  getStartLpWindowInstructionAsync, findClaimPda } from '../../../clients/chain/dist/index.js';
import type { FinancialEpochChain, FinalizedEpochState } from '../../keeper/src/flow.ts';
import type { AcceptedCandidate, SettlementScope } from '../../keeper/src/candidate.ts';
import type { KeeperAttempt } from '../../keeper/src/attempts.ts';
import type {EmptyWindowState} from '../../keeper/src/lp-recovery.ts';
import { FinalizedFinancialAccounts, FirstSliceFinancialReader } from './financial-chain.ts';

const equal=(a:ReadonlyUint8Array,b:ReadonlyUint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const hex=(a:ReadonlyUint8Array)=>Buffer.from(a).toString('hex');

/** An operator-owned signer/submitter. D does not load a key or submit by itself. */
export interface KeeperInstructionTransport {
  publisherAddress:string;keeperAddress:string;
  send(instruction:Instruction,authority:'publisher'|'keeper',onSigned?:(signature:string)=>void):Promise<string>;
  signatureStatus(signature:string):Promise<'FINALIZED'|'FAILED'|'PENDING'>;
}

/** B account and generated-instruction implementation of keeper's epoch chain boundary. */
export class KitFinancialEpochChain implements FinancialEpochChain {
  readonly state:FinalizedFinancialAccounts;
  readonly reader:FirstSliceFinancialReader;
  readonly transport:KeeperInstructionTransport;
  readonly scope:SettlementScope;
  constructor(state:FinalizedFinancialAccounts,reader:FirstSliceFinancialReader,transport:KeeperInstructionTransport,scope:SettlementScope){
    this.state=state;this.reader=reader;this.transport=transport;this.scope=scope;
  }
  private async authority() {
    const config=await this.state.config();
    if (String(config.publisher)!==this.transport.publisherAddress) throw new Error('KEEPER_PUBLISHER_MISMATCH');
    return config;
  }
  async readEmptyWindow(marketId:string):Promise<EmptyWindowState> {
    if (marketId!==this.scope.marketId) throw new Error('KEEPER_SCOPE_MISMATCH');
    const [market,fm,vault]=await Promise.all([this.state.market(marketId),this.state.financeMarket(marketId),
      this.reader.vault(marketId)]);
    return {marketId,cycle:fm.currentCycle.toString(),currentMaturity:Number(fm.currentMaturity),
      openPositions:fm.openPositions,totalShares:fm.totalShares.toString(),lpGeneration:fm.lpGeneration.toString(),
      validityGeneration:market.validityGeneration.toString(),lastLpMaturity:Number(fm.lastLpMaturity),
      lpWindowStart:Number(fm.lpWindowStart),lpWindowEnd:Number(fm.lpWindowEnd),
      navValid:market.phase===MarketPhase.Indexed && !!vault?.value.navAtoms && fm.totalShares>0n &&
        (market.dataStatus===DataStatus.LowActivity ||
          market.dataStatus===DataStatus.Valid && market.admission.state===AdmissionState.Open)};
  }
  async read(scope:SettlementScope):Promise<FinalizedEpochState> {
    if (scope.marketId!==this.scope.marketId || scope.epoch!==this.scope.epoch || scope.programId!==this.state.options.programId ||
        scope.cluster!==this.state.options.cluster) throw new Error('KEEPER_SCOPE_MISMATCH');
    const [market,fm,scan]=await Promise.all([this.state.market(scope.marketId),this.state.financeMarket(scope.marketId),this.state.programAccounts()]);
    if (!scan || market.phase!==MarketPhase.Indexed || fm.currentCycle.toString()!==scope.epoch ||
        hex(market.queryHash)!==scope.queryHash || market.queryVersion.toString()!==scope.queryVersion ||
        fm.anchorPg.toString()!==scope.anchor.graduationPriceAtoms || fm.anchorSg.toString()!==scope.anchor.graduationNowQ12 ||
        fm.anchorDg.toString()!==scope.anchor.graduation7dQ12 || fm.pmax.toString()!==scope.anchor.maxPriceAtoms) throw new Error('KEEPER_CHAIN_STATE_MISMATCH');
    const cyclePositions=[] as Array<{address:string;marketId:string;cycle:string;openedAt:bigint;open:boolean}>;
    for (const account of scan.accounts) {
      if (!equal(account.data.subarray(0,8),PRO_POSITION_DISCRIMINATOR)) continue;
      const raw=getProPositionDecoder().decode(account.data);
      if (String(raw.market)!==scope.marketId || raw.cycle!==fm.currentCycle) continue;
      const position=await this.state.position(account.address);
      if (!position || position.cycle!==fm.currentCycle) throw new Error('KEEPER_POSITION_INVALID');
      cyclePositions.push({address:account.address,marketId:scope.marketId,cycle:scope.epoch,openedAt:position.openedAt,open:position.state===PositionState.Open});
    }
    if (!cyclePositions.length) throw new Error('KEEPER_CYCLE_POSITIONS_UNAVAILABLE');
    const epochStartedAt=cyclePositions.reduce((min,p)=>p.openedAt<min?p.openedAt:min,cyclePositions[0].openedAt);
    if (epochStartedAt!==BigInt(scope.epochStartedAt)) throw new Error('KEEPER_EPOCH_START_MISMATCH');
    const settlement=await this.state.settlement(scope.marketId,fm.currentCycle);
    const vault=await this.reader.vault(scope.marketId);
    const navValid=!!vault?.value.navAtoms && fm.totalShares>0n &&
      (market.dataStatus===DataStatus.LowActivity || market.dataStatus===DataStatus.Valid && market.admission.state===AdmissionState.Open);
    const value=settlement?.value;
    return {marketId:scope.marketId,cycle:fm.currentCycle.toString(),epochStartedAt:Number(epochStartedAt),maturityAt:Number(fm.currentMaturity),
      settlement:value?{marketId:String(value.market),cycle:value.cycle.toString(),epoch:value.epoch.toString(),maturityAt:Number(value.maturityAt),
        candidateHash:hex(value.candidateHash),priceAtoms:value.price.toString(),mode:({[SettlementMode.Normal]:'NORMAL',
          [SettlementMode.Recovery]:'RECOVERY',[SettlementMode.Emergency]:'EMERGENCY'} as const)[value.mode],
        effectiveCloseAt:Number(value.effectiveCloseAt),acceptedAt:Number(value.acceptedAt)}:null,
      openPositions:cyclePositions.filter(p=>p.open).map(p=>({address:p.address,marketId:p.marketId,cycle:p.cycle})),
      openPositionCount:fm.openPositions,lpWindowStart:Number(fm.lpWindowStart),lpWindowEnd:Number(fm.lpWindowEnd),navValid};
  }
  async verifyAttempt(attempt:KeeperAttempt):Promise<'FINALIZED'|'FAILED'|'PENDING'> {
    const marketId=attempt.marketId,cycle=BigInt(attempt.cycle);
    if (attempt.action==='ACCEPT_SETTLEMENT') {
      const settled=await this.state.settlement(marketId,cycle);
      if (settled && hex(settled.value.candidateHash)===attempt.fingerprint && settled.value.epoch===cycle) return 'FINALIZED';
      if (settled) throw new Error('KEEPER_SETTLEMENT_ACCOUNT_MISMATCH');
    } else if (attempt.action==='SETTLE_PRO') {
      const position=await this.state.position(attempt.entity),claim=await this.state.claim(attempt.entity);
      if (position?.state===PositionState.Settled && claim && String(claim.value.market)===marketId && claim.value.position===address(attempt.entity)) return 'FINALIZED';
    } else if (attempt.action==='RECOVER_LP_WINDOW') {
      const [fm,market]=await Promise.all([this.state.financeMarket(marketId),this.state.market(marketId)]);
      const [week,generation]=attempt.entity.split(':');
      if (fm.currentCycle===cycle && fm.currentMaturity===0n && fm.lpWindowEnd>fm.lpWindowStart &&
          fm.lastLpMaturity>=BigInt(week) && fm.lpGeneration===BigInt(generation) &&
          market.validityGeneration===fm.lpGeneration) return 'FINALIZED';
    } else {
      const [fm,settled]=await Promise.all([this.state.financeMarket(marketId),this.state.settlement(marketId,cycle)]);
      if (settled && fm.lpWindowStart>=settled.value.acceptedAt && fm.lpWindowEnd>fm.lpWindowStart) return 'FINALIZED';
    }
    return attempt.signature?this.transport.signatureStatus(attempt.signature):'PENDING';
  }
  async accept(candidate:AcceptedCandidate,onSigned?:(signature:string)=>void):Promise<string> {
    const config=await this.authority(),programAddress=address(this.state.options.programId);
    const [market,fm]=await Promise.all([this.state.market(candidate.marketId),this.state.financeMarket(candidate.marketId)]);
    if (market.phase!==MarketPhase.Indexed || fm.currentCycle!==candidate.epoch || fm.currentMaturity!==candidate.maturityAt ||
        hex(market.queryHash)!==this.scope.queryHash || market.queryVersion.toString()!==this.scope.queryVersion ||
        fm.anchorPg.toString()!==this.scope.anchor.graduationPriceAtoms || fm.anchorSg.toString()!==this.scope.anchor.graduationNowQ12 ||
        fm.anchorDg.toString()!==this.scope.anchor.graduation7dQ12 || fm.pmax.toString()!==this.scope.anchor.maxPriceAtoms ||
        market.queryVersion!==candidate.queryVersion || config.configVersion!==candidate.configVersion ||
        await this.state.settlement(candidate.marketId,fm.currentCycle)) throw new Error('KEEPER_CANDIDATE_STALE');
    if (candidate.mode==='EMERGENCY') {
      if (!candidate.emergencySnapshot) throw new Error('KEEPER_EMERGENCY_SNAPSHOT_MISSING');
      const snapshot=await this.state.snapshot(candidate.marketId,candidate.emergencySnapshot.sequence);
      if (!snapshot || !equal(snapshot.payloadHash,candidate.emergencySnapshot.payloadHash) ||
          !equal(snapshot.queryHash,market.queryHash) || snapshot.queryVersion!==candidate.queryVersion ||
          snapshot.dataThrough!==BigInt(candidate.dataThrough) || snapshot.dataThrough>candidate.outageStartedAt ||
          snapshot.publishedAt!==BigInt(candidate.emergencySnapshot.publishedAt) ||
          snapshot.publishedAt>candidate.outageStartedAt ||
          snapshot.activityNowQ12.__option!=='Some' || snapshot.activityNowQ12.value!==candidate.activityNowQ12 ||
          snapshot.activity7dQ12.__option!=='Some' || snapshot.activity7dQ12.value!==candidate.activity7dQ12)
        throw new Error('KEEPER_EMERGENCY_SNAPSHOT_MISMATCH');
    }
    const settlement=await this.state.settlementAddress(candidate.marketId,fm.currentCycle);
    const mode=({NORMAL:SettlementMode.Normal,RECOVERY:SettlementMode.Recovery,EMERGENCY:SettlementMode.Emergency} as const)[candidate.mode];
    const ix=await getAcceptSettlementInstructionAsync({market:address(candidate.marketId),settlement:address(settlement),
      publisher:createNoopSigner(address(this.transport.publisherAddress)),epoch:candidate.epoch,maturityAt:candidate.maturityAt,
      candidateHash:candidate.candidateHash,evidenceHash:candidate.evidenceHash,mode,eligibleAt:candidate.eligibleAt,
      effectiveCloseAt:candidate.effectiveCloseAt,outageStartedAt:candidate.outageStartedAt,
      settlementPrice:candidate.settlementPrice,activityNowQ12:candidate.activityNowQ12,
      activity7dQ12:candidate.activity7dQ12,queryVersion:candidate.queryVersion,
      expectedConfigVersion:candidate.configVersion},{programAddress});
    return this.transport.send(ix,'publisher',onSigned);
  }
  async settle(marketId:string,positionAddress:string,onSigned?:(signature:string)=>void):Promise<string> {
    const programAddress=address(this.state.options.programId),position=await this.state.position(positionAddress);
    if (!position || String(position.market)!==marketId || position.state!==PositionState.Open) throw new Error('KEEPER_POSITION_UNAVAILABLE');
    const settlement=await this.state.settlement(marketId,position.cycle);
    if (!settlement || settlement.value.maturityAt!==position.maturity) throw new Error('KEEPER_SETTLEMENT_ACCOUNT_MISMATCH');
    const [claim]=await findClaimPda({position:address(positionAddress)},{programAddress});
    if (await this.state.claim(positionAddress)) throw new Error('KEEPER_CLAIM_ALREADY_EXISTS');
    const ix=await getSettleProInstructionAsync({market:address(marketId),position:address(positionAddress),
      settlement:address(settlement.address),claim,keeper:createNoopSigner(address(this.transport.keeperAddress))},{programAddress});
    return this.transport.send(ix,'keeper',onSigned);
  }
  async startLpWindow(marketId:string,onSigned?:(signature:string)=>void):Promise<string> {
    await this.authority();
    const fm=await this.state.financeMarket(marketId),settlement=await this.state.settlement(marketId,fm.currentCycle);
    if (fm.openPositions!==0 || fm.currentMaturity!==0n && !settlement) throw new Error('KEEPER_SETTLEMENT_INCOMPLETE');
    const vault=await this.reader.vault(marketId);
    if (!vault?.value.navAtoms) throw new Error('KEEPER_NAV_UNAVAILABLE');
    const settlementAddress=settlement?.address??await this.state.settlementAddress(marketId,fm.currentCycle);
    const ix=await getStartLpWindowInstructionAsync({market:address(marketId),settlement:address(settlementAddress),
      publisher:createNoopSigner(address(this.transport.publisherAddress))},{programAddress:address(this.state.options.programId)});
    return this.transport.send(ix,'publisher',onSigned);
  }
}
