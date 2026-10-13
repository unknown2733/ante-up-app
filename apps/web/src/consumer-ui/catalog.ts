import type { ConsumerMarket } from '../../../../contracts/consumer';

/** Presentation metadata for the existing on-chain market; identity and values stay untouched. */
export function withVerifiedSubjectMedia(market: ConsumerMarket): ConsumerMarket {
  if (market.source.mode !== 'LIVE' || market.id !== '7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT') return market;
  return { ...market, thumbnailUrl: 'https://solana.com/src/img/branding/solanaLogoMark.png',
    imageAlt: 'Official Solana logomark', imageSourceUrl: 'https://solana.com/branding', subjectUrl: 'https://solana.com',
    creatorLabel: 'Solana' };
}

/** Stable ID identity wins over title similarity; a real market takes precedence on an ID collision. */
export function mergeConsumerMarkets(samples: ConsumerMarket[], live: ConsumerMarket[]): ConsumerMarket[] {
  const byId = new Map<string, ConsumerMarket>();
  for (const market of samples) byId.set(market.id, market);
  for (const market of live) byId.set(market.id, market);
  return [...byId.values()].sort((a, b) => a.source.mode === b.source.mode
    ? a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
    : a.source.mode === 'LIVE' ? -1 : 1);
}

/** Display names only: API identity, measurements, and provenance stay unchanged. */
export const marketDisplayTitle = (title: string) => title === 'Synthetic finance demo' ? 'Market index' : title;
export const marketDisplaySubtitle = (market: ConsumerMarket) => market.source.observationLabel === 'Operator-generated test inputs; no real-world traffic' ? 'Index market' : market.subtitle;
