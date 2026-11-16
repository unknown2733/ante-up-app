import type { Action, MarketView } from '../../../contracts/types';

type MarketStatusInput = Pick<MarketView, 'phase' | 'dataStatus' | 'price' | 'priceReadiness'>;
type Tone = 'green' | 'orange' | 'red';

const labels: Record<MarketView['dataStatus'], { label: string; tone: Tone }> = {
  PREPARING: { label: 'Preparing data', tone: 'orange' },
  VALID: { label: 'Data current', tone: 'green' },
  LOW_ACTIVITY: { label: 'Low activity', tone: 'orange' },
  OUTAGE: { label: 'Data unavailable', tone: 'red' },
};

/** A VALID on-chain snapshot can age out before a fresh executable price exists. */
export function marketStatusView(market: MarketStatusInput): { label: string; tone: Tone; delayed: boolean } {
  if(market.priceReadiness?.state==='SYNCING')return {label:'Syncing latest observation',tone:'orange',delayed:true};
  if(market.priceReadiness?.state==='STALE')return {label:'Observation delayed',tone:'red',delayed:true};
  if (market.phase === 'INDEXED' && market.dataStatus === 'VALID' && market.price === null) {
    return { label: 'Index price unavailable', tone: 'red', delayed: true };
  }
  if(market.phase!=='INDEXED'&&market.dataStatus==='VALID')return {label:'Observed data',tone:'green',delayed:false};
  return { ...labels[market.dataStatus], delayed: false };
}

/** Explanations do not grant permission or replace wallet/quote verification. */
export function marketActionReason(market:MarketView,action:Action):string|null {
  const capability=market.capabilities[action];
  if(capability?.allowed||action==='claim')return null;
  if(capability?.reason==='LP_WINDOW_CLOSED')return 'Liquidity deposits and withdrawals reopen during the next weekly liquidity window.';
  if(capability?.reason!=='DATA_NOT_READY'&&!(action==='openFree'&&capability?.reason==='ENTRY_PAUSED'))return null;
  if(market.runtimeStatus?.reason==='STORAGE_PRESSURE')return action==='openFree'
    ?'New chips are paused because storage has reached its limit. Existing chips can still be taken back.'
    :'Data updates are paused because storage has reached its limit. Price-based quotes resume after updates recover.';
  if(market.runtimeStatus?.reason==='RPC_RATE_LIMITED')return 'The Devnet connection is busy. Wait a moment before requesting a fresh quote.';
  if(market.runtimeStatus?.reason==='PUBLICATION_PENDING')return 'A data update is awaiting chain verification. Price-based quotes resume after verification.';
  if(capability?.reason==='DATA_NOT_READY'&&market.priceReadiness?.state==='STALE')return 'The latest observation is delayed. Price-based quotes resume after fresh data is verified.';
  if(capability?.reason==='DATA_NOT_READY'&&market.priceReadiness?.state==='SYNCING')return 'The latest observation is syncing. Price-based quotes resume after verification.';
  return null;
}
export function marketDataNotice(market:MarketView):string|null {
  if(market.runtimeStatus?.reason==='STORAGE_PRESSURE')return 'Data updates are paused because storage has reached its limit. Existing records remain available.';
  if(market.runtimeStatus?.reason==='RPC_RATE_LIMITED')return 'The Devnet connection is busy. Market data may take longer to update.';
  if(market.runtimeStatus?.reason==='PUBLICATION_PENDING')return 'A data update is awaiting chain verification. Price-based quotes resume after verification.';
  if(market.priceReadiness?.state==='SYNCING')return 'Syncing the latest observation. Price-based quotes are paused while we verify it. Checking again automatically.';
  if(market.priceReadiness?.state==='STALE')return 'The latest observation is delayed. Price-based quotes resume after fresh data is verified.';
  return marketStatusView(market).delayed?'A current verified index price is unavailable. Price-based quotes resume after the index is verified again.':null;
}
