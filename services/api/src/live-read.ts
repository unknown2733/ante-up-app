import { address } from '@solana/kit';
import { AdmissionState, DataStatus, MarketPhase, findMarketPda, findAdmissionPda, findFinanceMarketPda, getMarketDecoder, getAdmissionDecoder,
  MARKET_DISCRIMINATOR, ADMISSION_DISCRIMINATOR } from '../../../clients/chain/dist/index.js';
import type { Capability, ErrorCode, FreeRecord, MarketView, ProofStatus } from '../../../contracts/types.ts';
import { SqliteProjectionStore } from '../../indexer/src/sqlite.ts';
import { SqliteEventRepositories, type FinalizedAccountReader } from '../../indexer/src/repositories.ts';
import type { ReadAdapter } from './app.ts';
import type { FreeStateReader } from './transaction.ts';
import { FinalizedFinancialAccounts, financialEpochPhase } from './financial-chain.ts';
import type { SqliteFinancialRegistrationStore } from './registration.ts';
import { UNIT, indexPrice, freeCapital } from '../../../contracts/reference.mjs';

export interface MarketRegistryEntry {address:string;seedHex:string;keyword:string;aliases:string[];dataProvenance?:'SYNTHETIC_QA'}
export function mergeMarketRegistry(registry:MarketRegistryEntry[],registrations:MarketRegistryEntry[]):MarketRegistryEntry[] {
  return [...new Map([...registrations,...registry].map(entry=>[entry.address,entry])).values()];
}

/** Market-level eligibility only; wallet, amount and exact solvency are checked by quote + program. */
export function indexedCapabilities(input:{price:MarketView['price'];epochPhase:MarketView['epochPhase'];
  lowActivity:boolean;assets:bigint;free:bigint;nav:bigint;externalQ:bigint;inventory:bigint;
  totalShares:bigint;lockedShares:bigint;openPositions:number;otherReserved:bigint}):MarketView['capabilities'] {
  const cap=(allowed:boolean,reason:ErrorCode):Capability=>({allowed,reason:allowed?null:reason});
  const data=!!input.price,entry=input.price?.executable===true;
  const lpWindow=['INITIAL_LP','LP_WINDOW'].includes(input.epochPhase??'');
  const lp=data&&(entry||input.lowActivity)&&lpWindow&&input.openPositions===0&&input.nav>0n&&input.totalShares>0n;
  return {
    spotBuy:cap(entry&&input.free>0n&&input.inventory>0n,!entry?'DATA_NOT_READY':'INSUFFICIENT_FREE_CAPITAL'),
    spotSell:cap(data&&input.externalQ>0n&&input.assets>0n,!data?'DATA_NOT_READY':'LIMIT_REACHED'),
    openPro:cap(entry&&input.epochPhase==='PRO_OPEN'&&input.free>0n,!entry?'DATA_NOT_READY':input.epochPhase!=='PRO_OPEN'?'WRONG_PHASE':'INSUFFICIENT_FREE_CAPITAL'),
    closePro:cap(data&&input.openPositions>0&&['PRO_OPEN','OPEN_CUTOFF'].includes(input.epochPhase??''),!data?'DATA_NOT_READY':'WRONG_PHASE'),
    claim:cap(input.otherReserved>0n,'LIMIT_REACHED'),
    depositLP:cap(lp,!data?'DATA_NOT_READY':!lpWindow?'LP_WINDOW_CLOSED':'LIMIT_REACHED'),
    withdrawLP:cap(lp&&input.free>0n&&input.totalShares>input.lockedShares,!data?'DATA_NOT_READY':!lpWindow?'LP_WINDOW_CLOSED':input.free<=0n?'INSUFFICIENT_FREE_CAPITAL':'LIMIT_REACHED'),
  };
}

export class SqliteFinalizedReadAdapter implements ReadAdapter, FreeStateReader {
  readonly mode: 'localnet'|'devnet';
  private readonly programId: string;
  private readonly store: SqliteProjectionStore;
  private readonly repositories: SqliteEventRepositories;
  private readonly accounts: FinalizedAccountReader;
  private readonly registry: MarketRegistryEntry[];
  private readonly now: () => number;
  private readonly financial: FinalizedFinancialAccounts | null;
  private readonly registrations: SqliteFinancialRegistrationStore | null;
  constructor(options: {mode:'localnet'|'devnet';programId:string;store:SqliteProjectionStore;
    repositories:SqliteEventRepositories;accounts:FinalizedAccountReader;registry:MarketRegistryEntry[];now:()=>number;
    financial?:FinalizedFinancialAccounts;registrations?:SqliteFinancialRegistrationStore}) {
    this.mode=options.mode;this.programId=options.programId;this.store=options.store;
    this.repositories=options.repositories;this.accounts=options.accounts;this.registry=options.registry;this.now=options.now;
    this.financial=options.financial??null;this.registrations=options.registrations??null;
  }
  async market(marketId: string) {return (await this.markets()).find(m=>m.id===marketId)??null;}
  async record(recordId: string) {return (await this.records()).find(r=>r.id===recordId)??null;}
  async markets(): Promise<MarketView[]> {
    const snapshots=this.store.snapshots(this.mode,this.programId);
    const [admissionAddress]=await findAdmissionPda({programAddress:address(this.programId)});
    const admissionRaw=await this.accounts.get(String(admissionAddress));
    if (!admissionRaw || admissionRaw.ownerProgramId!==this.programId || !Buffer.from(admissionRaw.data.subarray(0,8)).equals(Buffer.from(ADMISSION_DISCRIMINATOR))) throw new Error('FINALIZED_ADMISSION_UNAVAILABLE');
    const admission=getAdmissionDecoder().decode(admissionRaw.data);
    const recent=admission.recent.filter((at:bigint)=>at>0n && BigInt(this.now())-at<86_400n).length;
    const freeEntry:Capability=!admission.open ? {allowed:false,reason:'ENTRY_PAUSED'}
      : admission.fundedOpenCount>=admission.fundedOpenCap ? {allowed:false,reason:'BUDGET_EXHAUSTED',detail:'FUNDED_PROOF_CAP'}
      : admission.outstanding>=200 ? {allowed:false,reason:'LIMIT_REACHED',detail:'GLOBAL_OUTSTANDING_LIMIT'}
      : recent>=100 ? {allowed:false,reason:'LIMIT_REACHED',detail:'GLOBAL_DAILY_LIMIT'}
      : {allowed:true,reason:null};
    const result:MarketView[]=[];
    // Operator registry is authoritative for display/provenance; auto registrations cannot relabel a synthetic feed.
    const entries=mergeMarketRegistry(this.registry,this.registrations?.finalized()??[]);
    for (const entry of entries) {
      if (!/^[0-9a-f]{64}$/.test(entry.seedHex)) throw new Error('INVALID_MARKET_SEED');
      const seed=Uint8Array.from(Buffer.from(entry.seedHex,'hex'));
      const [expected]=await findMarketPda({marketId:seed},{programAddress:address(this.programId)});
      if (String(expected)!==entry.address) throw new Error('MARKET_REGISTRY_PDA_MISMATCH');
      const raw=await this.accounts.get(entry.address);
      if (!raw || raw.ownerProgramId!==this.programId || !Buffer.from(raw.data.subarray(0,8)).equals(Buffer.from(MARKET_DISCRIMINATOR))) throw new Error('FINALIZED_MARKET_UNAVAILABLE');
      const chain=getMarketDecoder().decode(raw.data);
      if (!Buffer.from(chain.id).equals(Buffer.from(seed))) throw new Error('MARKET_SEED_MISMATCH');
      const phase=({[MarketPhase.Curve]:'CURVE',[MarketPhase.GraduationWait]:'GRADUATION_WAIT',[MarketPhase.Indexed]:'INDEXED'} as const)[chain.phase as MarketPhase];
      const dataStatus=({[DataStatus.Preparing]:'PREPARING',[DataStatus.Valid]:'VALID',[DataStatus.LowActivity]:'LOW_ACTIVITY',[DataStatus.Outage]:'OUTAGE'} as const)[chain.dataStatus as DataStatus];
      if (!phase || !dataStatus) throw new Error('MARKET_ENUM_INVALID');
      const latest=snapshots.filter(s=>s.payload.marketId===entry.address).sort((a,b)=>BigInt(a.payload.sequence)<BigInt(b.payload.sequence)?1:-1)[0]??null;
      const matched=latest && latest.payload.sequence===chain.latestSequence.toString() && Buffer.from(chain.latestHash).toString('hex')===latest.payloadHash;
      const snapshot=matched?latest:null;
      let anchor=null,price=null,epochPhase=null;
      let financialCaps:MarketView['capabilities']={};
      if (this.financial) {
        try {
          const fm=await this.financial.financeMarket(entry.address);
          if (phase==='CURVE') price={kind:'curve' as const,atoms:(UNIT+fm.curveSold/5000n).toString(),executable:true};
          if (phase==='INDEXED' && fm.anchorPg>0n && fm.pmax>0n) {
            epochPhase=await financialEpochPhase(this.financial,entry.address,chain,fm,this.now());
            anchor={graduationPriceAtoms:fm.anchorPg.toString(),graduationNowQ12:fm.anchorSg.toString(),graduation7dQ12:fm.anchorDg.toString(),maxPriceAtoms:fm.pmax.toString()};
            const s=chain.latestNowQ12,d=chain.latest7dQ12;
            const fresh=chain.latestDataThrough<=BigInt(this.now()) && BigInt(this.now())-chain.latestDataThrough<600n;
            if (matched && fresh && s.__option==='Some' && d.__option==='Some' && d.value>0n &&
                (chain.dataStatus===DataStatus.Valid || chain.dataStatus===DataStatus.LowActivity)) {
              try {
                const calculated=indexPrice(fm.anchorPg,fm.anchorSg,fm.anchorDg,s.value,d.value);
                if (calculated.maximum===fm.pmax) price={kind:'indexed' as const,atoms:calculated.price.toString(),
                  executable:chain.dataStatus===DataStatus.Valid && chain.admission.state===AdmissionState.Open && calculated.price>0n};
              } catch { /* Invalid on-chain ratio has no displayed price. */ }
            }
            const financeConfig=await this.financial.financeConfig();
            const [fmAddress]=await findFinanceMarketPda({market:address(entry.address)},{programAddress:address(this.programId)});
            const [vault,inventory]=await Promise.all([
              this.financial.tokenAt(String(fm.paymentVault),String(financeConfig.paymentMint),String(fmAddress)),
              this.financial.tokenAt(String(fm.vaultInventory),String(fm.keywordMint),String(fmAddress))]);
            const free=freeCapital(vault.amount,fm.externalQ,fm.pmax,fm.proReserved,fm.otherReserved,500n*UNIT) as bigint;
            const nav=price?vault.amount-fm.externalQ*BigInt(price.atoms)/UNIT-fm.otherReserved:0n;
            financialCaps=indexedCapabilities({price,epochPhase,lowActivity:dataStatus==='LOW_ACTIVITY',assets:vault.amount,
              free,nav,externalQ:fm.externalQ,inventory:inventory.amount,totalShares:fm.totalShares,lockedShares:fm.lockedShares,
              openPositions:fm.openPositions,otherReserved:fm.otherReserved});
          }
        } catch (error) { if (this.registrations?.finalized().some(r=>r.address===entry.address)) throw error; }
      }
      result.push({id:entry.address,keyword:entry.keyword,aliases:entry.aliases,phase,dataStatus,epochPhase,supported:true,
        ...(entry.dataProvenance==='SYNTHETIC_QA'?{dataProvenance:'SYNTHETIC_QA' as const}:{}),
        chain:{cluster:this.mode,programId:this.programId,address:entry.address},snapshot,anchor,price,
        capabilities:{...financialCaps,curveBuy:{allowed:phase==='CURVE',reason:phase==='CURVE'?null:'WRONG_PHASE'},curveSell:{allowed:phase==='CURVE',reason:phase==='CURVE'?null:'WRONG_PHASE'},
          openFree:entry.dataProvenance==='SYNTHETIC_QA'?{allowed:false,reason:'ENTRY_PAUSED'}:freeEntry,
          closeFree:{allowed:true,reason:null}}});
    }
    return result;
  }
  async records(): Promise<FreeRecord[]> {return this.store.records(this.mode,this.programId);}
  async proofs(): Promise<ProofStatus[]> {return this.repositories.proofs(this.mode,this.programId);}
  async heldCalculationWallets(): Promise<Set<string>> {return new Set();}
}
