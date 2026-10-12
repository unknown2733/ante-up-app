import { address } from '@solana/kit';
import { AdmissionState, DataStatus, MarketPhase, findMarketPda, findAdmissionPda, getMarketDecoder, getAdmissionDecoder,
  MARKET_DISCRIMINATOR, ADMISSION_DISCRIMINATOR } from '../../../clients/chain/dist/index.js';
import type { Capability, FreeRecord, MarketView, ProofStatus } from '../../../contracts/types.ts';
import { SqliteProjectionStore } from '../../indexer/src/sqlite.ts';
import { SqliteEventRepositories, type FinalizedAccountReader } from '../../indexer/src/repositories.ts';
import type { ReadAdapter } from './app.ts';
import type { FreeStateReader } from './transaction.ts';
import { FinalizedFinancialAccounts, financialEpochPhase } from './financial-chain.ts';
import type { SqliteFinancialRegistrationStore } from './registration.ts';
import { UNIT, indexPrice } from '../../../contracts/reference.mjs';

export interface MarketRegistryEntry {address:string;seedHex:string;keyword:string;aliases:string[];dataProvenance?:'SYNTHETIC_QA'}
export function mergeMarketRegistry(registry:MarketRegistryEntry[],registrations:MarketRegistryEntry[]):MarketRegistryEntry[] {
  return [...new Map([...registrations,...registry].map(entry=>[entry.address,entry])).values()];
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
    const recent=admission.recent.filter(at=>at>0n && BigInt(this.now())-at<86_400n).length;
    const freeEntry:Capability=!admission.open ? {allowed:false,reason:'ENTRY_PAUSED'}
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
      const phase=({[MarketPhase.Curve]:'CURVE',[MarketPhase.GraduationWait]:'GRADUATION_WAIT',[MarketPhase.Indexed]:'INDEXED'} as const)[chain.phase];
      const dataStatus=({[DataStatus.Preparing]:'PREPARING',[DataStatus.Valid]:'VALID',[DataStatus.LowActivity]:'LOW_ACTIVITY',[DataStatus.Outage]:'OUTAGE'} as const)[chain.dataStatus];
      if (!phase || !dataStatus) throw new Error('MARKET_ENUM_INVALID');
      const latest=snapshots.filter(s=>s.payload.marketId===entry.address).sort((a,b)=>BigInt(a.payload.sequence)<BigInt(b.payload.sequence)?1:-1)[0]??null;
      const matched=latest && latest.payload.sequence===chain.latestSequence.toString() && Buffer.from(chain.latestHash).toString('hex')===latest.payloadHash;
      const snapshot=matched?latest:null;
      let anchor=null,price=null,epochPhase=null;
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
          }
        } catch (error) { if (this.registrations?.finalized().some(r=>r.address===entry.address)) throw error; }
      }
      result.push({id:entry.address,keyword:entry.keyword,aliases:entry.aliases,phase,dataStatus,epochPhase,supported:true,
        ...(entry.dataProvenance==='SYNTHETIC_QA'?{dataProvenance:'SYNTHETIC_QA' as const}:{}),
        chain:{cluster:this.mode,programId:this.programId,address:entry.address},snapshot,anchor,price,
        capabilities:{curveBuy:{allowed:phase==='CURVE',reason:phase==='CURVE'?null:'WRONG_PHASE'},curveSell:{allowed:phase==='CURVE',reason:phase==='CURVE'?null:'WRONG_PHASE'},
          openFree:entry.dataProvenance==='SYNTHETIC_QA'?{allowed:false,reason:'ENTRY_PAUSED'}:freeEntry,
          closeFree:{allowed:true,reason:null}}});
    }
    return result;
  }
  async records(): Promise<FreeRecord[]> {return this.store.records(this.mode,this.programId);}
  async proofs(): Promise<ProofStatus[]> {return this.repositories.proofs(this.mode,this.programId);}
  async heldCalculationWallets(): Promise<Set<string>> {return new Set();}
}
