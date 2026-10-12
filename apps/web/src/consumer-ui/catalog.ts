import type { ConsumerMarket } from '../../../../contracts/consumer';

/** Stable ID identity wins over title similarity; a real market takes precedence on an ID collision. */
export function mergeConsumerMarkets(samples: ConsumerMarket[], live: ConsumerMarket[]): ConsumerMarket[] {
  const byId = new Map<string, ConsumerMarket>();
  for (const market of samples) byId.set(market.id, market);
  for (const market of live) byId.set(market.id, market);
  return [...byId.values()].sort((a, b) => a.source.mode === b.source.mode
    ? a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
    : a.source.mode === 'LIVE' ? -1 : 1);
}
