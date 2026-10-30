import type { MarketView } from '../../../contracts/types';

type MarketStatusInput = Pick<MarketView, 'phase' | 'dataStatus' | 'price'>;
type Tone = 'green' | 'orange' | 'red';

const labels: Record<MarketView['dataStatus'], { label: string; tone: Tone }> = {
  PREPARING: { label: 'Preparing data', tone: 'orange' },
  VALID: { label: 'Data current', tone: 'green' },
  LOW_ACTIVITY: { label: 'Low activity', tone: 'orange' },
  OUTAGE: { label: 'Data unavailable', tone: 'red' },
};

/** A VALID on-chain snapshot can age out before a fresh executable price exists. */
export function marketStatusView(market: MarketStatusInput): { label: string; tone: Tone; delayed: boolean } {
  if (market.phase === 'INDEXED' && market.dataStatus === 'VALID' && market.price === null) {
    return { label: 'Index price unavailable', tone: 'red', delayed: true };
  }
  return { ...labels[market.dataStatus], delayed: false };
}
