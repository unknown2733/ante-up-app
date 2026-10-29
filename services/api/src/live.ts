import { createApp } from './app.ts';
import { SqliteProjectionStore } from '../../indexer/src/sqlite.ts';
import { KitFinalizedAccountReader, SqliteEventRepositories, type FinalizedAccountReader } from '../../indexer/src/repositories.ts';
import { SqliteFinalizedReadAdapter, type MarketRegistryEntry } from './live-read.ts';
import { LiveStore } from './live-store.ts';
import { KitBlockhashProvider, KitFreeTransactionAdapter, type BlockhashProvider } from './transaction.ts';
import { KitOperationChain, reconcileLiveOperation, type OperationChain } from './operation-chain.ts';
import type { SignatureVerifier } from './auth.ts';
import type { FinancialReader, FinancialTransactionAdapter } from './financial.ts';
import { FinalizedFinancialAccounts, FirstSliceFinancialReader } from './financial-chain.ts';
import { KitFirstSliceFinancialTransactionAdapter } from './financial-transaction.ts';
import { SqliteFinancialRegistrationStore } from './registration.ts';
import { KitConfirmedFinancialClock, type FinancialClock } from './financial-clock.ts';
import { existsSync } from 'node:fs';
import { consumerLiveNamespace } from '../../../contracts/consumer-identity.ts';
import type { ConsumerReadApi } from '../../../contracts/consumer.ts';
import { combinePriceObservationReaders, createFinalizedConsumerHistory, projectConsumerMarket, SqliteFinalizedQuoteHistory } from './consumer-history.ts';
import { openPriceHistoryReadStore } from './consumer-price-sampler.ts';
import { ConsumerNoteService, createConsumerSocialProjection, createFinalizedFreeActionLookup, SqliteNotePersistence } from './consumer-social.ts';
import type { VisitorSolFaucet } from './visitor-faucet.ts';
import { ReferenceObservationStore } from './reference-observations.ts';
import { createRpcReadFailover } from '../../indexer/src/rpc-failover.ts';
import { DEVNET_GENESIS } from './visitor-faucet.ts';

/** Explicit live construction; passing deterministic readers/providers performs no network calls. */
export function createLiveApp(config: {
  mode:'localnet'|'devnet';programId:string;rpcUrl:string;rpcReadFallbackUrl?:string;dbPath:string;markets:MarketRegistryEntry[];
  /** Optional dedicated sampler DB. If absent at boot, history remains sparse until restart. */
  priceDbPath?:string;
  now?:()=>number;accounts?:FinalizedAccountReader;blockhashes?:BlockhashProvider;chain?:OperationChain;
  verifier?:SignatureVerifier;nextRecordNonce?:()=>bigint;
  financial?:FinancialReader;
  financialTransactions?:FinancialTransactionAdapter;
  financialClock?:FinancialClock;
  visitorSol?:VisitorSolFaucet;
}) {
  const now=config.now??(()=>Math.floor(Date.now()/1000));
  const readRpc=config.rpcReadFallbackUrl
    ? createRpcReadFailover(config.rpcUrl,config.rpcReadFallbackUrl,{expectedGenesisHash:DEVNET_GENESIS,
      onFailover:()=>console.warn('RPC_READ_FAILOVER')})
    : null;
  const accounts=config.accounts??new KitFinalizedAccountReader(config.rpcUrl,readRpc??undefined);
  const projection=new SqliteProjectionStore(config.dbPath);
  const repositories=new SqliteEventRepositories(config.dbPath,accounts);
  const liveStore=new LiveStore(config.dbPath);
  const registrations=new SqliteFinancialRegistrationStore(config.dbPath);
  const financialState=new FinalizedFinancialAccounts({cluster:config.mode,programId:config.programId,accounts});
  const clock=new KitConfirmedFinancialClock(config.rpcUrl,{now,rpc:readRpc??undefined});
  const firstSlice=new FirstSliceFinancialReader(financialState,registrations,now,config.financialClock??(()=>clock.read()));
  const read=new SqliteFinalizedReadAdapter({mode:config.mode,programId:config.programId,store:projection,
    repositories,accounts,registry:config.markets,financial:financialState,registrations,now});
  const blockhashes=config.blockhashes??new KitBlockhashProvider(config.rpcUrl,readRpc??undefined);
  const transactions=new KitFreeTransactionAdapter({cluster:config.mode,programId:config.programId,read,
    blockhashes,now,nextRecordNonce:config.nextRecordNonce});
  let social: {
    notes: SqliteNotePersistence;
    quotes: SqliteFinalizedQuoteHistory;
    samples: ReturnType<typeof openPriceHistoryReadStore> | null;
  } | null = null;
  let consumer: { read: ConsumerReadApi; notes: ConsumerNoteService; namespace: string } | undefined;
  const referenceObservations = config.mode === 'devnet' ? new ReferenceObservationStore(config.dbPath) : null;
  if (config.mode === 'devnet') {
    const namespace = consumerLiveNamespace('devnet', config.programId);
    const notes = new SqliteNotePersistence(config.dbPath);
    const quotes = new SqliteFinalizedQuoteHistory(config.dbPath, 'devnet', config.programId);
    const samples = config.priceDbPath && existsSync(config.priceDbPath)
      ? openPriceHistoryReadStore(config.priceDbPath, config.programId) : null;
    const priceObservations = combinePriceObservationReaders(quotes, ...(samples ? [samples] : []));
    const history = createFinalizedConsumerHistory({ read, projection, cluster: 'devnet', programId: config.programId,
      priceObservations, noteForAction: actionId => notes.read(actionId), nowMs: () => now() * 1000 });
    const projected = createConsumerSocialProjection({ records: () => read.records(),
      heldWallets: () => read.heldCalculationWallets(), notes, namespace, clockMs: () => now() * 1000,
      label: 'Live Devnet · finalized' });
    const consumerRead: ConsumerReadApi = {
      listMarkets: async () => {
        const asOfMs = now() * 1000;
        return (await read.markets())
          .filter(market => market.dataProvenance !== 'SYNTHETIC_QA')
          .map(market => projectConsumerMarket(market, asOfMs));
      },
      getHistory: history.getHistory, getProfile: projected.getProfile, getLeaderboard: projected.getLeaderboard,
    };
    consumer = { read: consumerRead, notes: new ConsumerNoteService(createFinalizedFreeActionLookup(
      () => read.records(), namespace), notes), namespace };
    social = { notes, quotes, samples };
  }
  const chain=config.chain??new KitOperationChain(config.rpcUrl,readRpc??undefined);
  const app=createApp({mode:config.mode,programId:config.programId,read,transactions,liveStore,
    chain,verifier:config.verifier,financial:config.financial??firstSlice,
    financialTransactions:config.financialTransactions??new KitFirstSliceFinancialTransactionAdapter({state:financialState,reader:firstSlice,blockhashes,now}),
    finalizeRegistration:async requestId=>{await registrations.verifyAndFinalize(requestId,financialState);},now,consumer,
    reconcileExpiredRegistrations:async()=>{
      for(const requestId of registrations.expiredPending(now())){
        try{
          const operation=await reconcileLiveOperation(liveStore,chain,requestId,now());
          if(operation.state==='FINALIZED')await registrations.verifyAndFinalize(requestId,financialState);
        }catch{console.error('REGISTRATION_EXPIRY_RECONCILE_FAILED');}
      }
    },
    visitorSol:config.visitorSol,referenceObservations:referenceObservations??undefined});
  return {app,projection,repositories,liveStore,registrations,close() {
    social?.samples?.close();social?.quotes.close();social?.notes.close();referenceObservations?.close();
    registrations.close();liveStore.close();repositories.close();projection.close();
  }};
}
