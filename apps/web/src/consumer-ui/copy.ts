import type { ConsumerMarket, ConsumerSubject } from '../../../../contracts/consumer';

export const consumerCopy = {
  nav: { discover: 'Explore', leaderboard: 'Leaderboard', activity: 'My activity', funds: 'Funds', docs: 'Docs' },
  subjects: { KEYWORD: 'Keyword', POST: 'Post', VIDEO: 'Video', TRACK: 'Track', ALBUM: 'Album', ACCOUNT: 'Account' } satisfies Record<ConsumerSubject, string>,
  phases: { CURVE: 'Bonding curve', POOL: 'Pool', PREVIEW: 'Preview' } satisfies Record<ConsumerMarket['phase'], string>,
  actions: { openCall: 'Place chip', closeCall: 'Take back chip', buy: 'Buy', sell: 'Sell' },
  states: {
    loading: 'Loading markets…',
    empty: 'No markets found',
    emptyDetail: 'Try another search or subject.',
    unavailable: 'Price history is not available yet.',
    missingPrice: 'Price pending',
    ownCall: 'Your chip is active',
  },
} as const;

const errors: Record<string, string> = {
  ENTRY_PAUSED: 'New chips are temporarily paused. Existing chips can still be taken back.',
  GLOBAL_OUTSTANDING_LIMIT: 'The market-wide active chip limit has been reached. Existing chips can still be taken back.',
  GLOBAL_DAILY_LIMIT: 'The daily placement limit has been reached. Existing chips can still be taken back.',
  DATA_NOT_READY: 'Market data is still being prepared.',
  DATA_STALE: 'Market data is delayed. Try again when it updates.',
  LOW_ACTIVITY: 'New paid trades are paused while activity is low.',
  WRONG_PHASE: 'This action is not available at the current market stage.',
  PENDING_CONFIRMATION: 'Your earlier request is still being checked. Check its status before trying again.',
  REQUOTE_REQUIRED: 'The quote changed. Review a new quote before signing.',
  LIMIT_REACHED: 'You have reached the current limit.',
  BUDGET_EXHAUSTED: 'This action is temporarily unavailable.',
  STORAGE_BACKLOG: 'Proof storage is catching up. Your finalized result stays recorded.',
  INSUFFICIENT_FREE_CAPITAL: 'There is not enough available capital for this trade.',
  UNAUTHORIZED: 'Connect the wallet that owns this action.',
};

/** Keep raw server details out of primary action copy; preserve request IDs in receipt details. */
export function consumerError(code: string | null | undefined, fallback = 'Something went wrong. Please try again.'): string {
  return code ? errors[code] ?? fallback : fallback;
}

/** Display known API codes plainly while keeping provider-owned non-English text out of English UI. */
export function displayConsumerError(reason: string | null | undefined, fallback = 'Could not complete the request.'): string {
  if (!reason) return fallback;
  return consumerError(reason, /[가-힣]/u.test(reason) ? fallback : reason);
}

export function formatChange(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const percentage = value * 100;
  return `${percentage > 0 ? '+' : ''}${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(percentage)}%`;
}

export function formatDisplayPrice(value: string | null, unit: string): string {
  if (value === null) return '—';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '—';
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(parsed)} ${unit}`.trim();
}
