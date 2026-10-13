import type { Mode } from '../../../../contracts/types';
import type { FreeOutcome } from '../liveFree';
import { isChainAddress, transactionHref } from './proofLinks.ts';
import { displayConsumerError } from '../consumer-ui/copy.ts';

export function executionResult(outcome: FreeOutcome, action: 'openFree' | 'closeFree', mode: Mode | null) {
  const finalized = outcome.state === 'FINALIZED';
  // Only these states have a reconciliation control in LiveFreeAction. Before-signing
  // failures and BUSY must not direct the user to a nonexistent "check request" button.
  const pending = ['UNKNOWN', 'SUBMITTED', 'CONFIRMED'].includes(outcome.state);
  const beforeSigning = outcome.state === 'AWAITING_SIGNATURE';
  const rawReason = outcome.reason?.trim() ?? '';
  const reason = rawReason ? displayConsumerError(rawReason) : '';
  const expired = (beforeSigning || outcome.state === 'FAILED') && /expir|requote/i.test(rawReason);
  const cancelled = (beforeSigning || outcome.state === 'FAILED') && /cancel|reject|declin/i.test(rawReason);
  const authentication = beforeSigning && /challenge|authenticat|session|sign.?in|sign.?message/i.test(rawReason);
  const title = finalized ? action === 'closeFree' ? 'Chip taken back.' : 'Your chip is placed.'
    : pending ? 'Your request is not final yet.'
    : cancelled ? 'Request cancelled.'
    : authentication ? 'Wallet authentication did not complete.'
    : expired ? 'Request expired.'
    : beforeSigning ? 'Transaction signing did not complete.'
    : outcome.state === 'BUSY' ? 'A wallet request is already in progress.'
    : outcome.state === 'UNAVAILABLE' ? 'Chip action is unavailable.' : 'Chip action did not complete.';
  const guidance = pending ? 'Check the existing request before starting another one. A wallet approval alone does not confirm execution.'
    : beforeSigning ? 'Review this message before trying the action again. If a wallet request is still open, finish or cancel it first.'
    : outcome.state === 'BUSY' ? 'Finish or cancel the earlier request in your wallet before starting another one.'
    : outcome.state === 'UNAVAILABLE' ? 'Resolve the availability issue before trying this action.'
    : 'No successful chip action is confirmed here. Review the reason before trying again.';
  const description = finalized ? action === 'closeFree' ? 'Your result is recorded. Open it to create a result card and follow proof issuance.' : 'The placement is on chain. Open your record to follow the result.'
    : [reason, guidance].filter(Boolean).join(' ');
  return { title, description, finalized, pending,
    recordHref: finalized && mode === 'devnet' && isChainAddress(outcome.recordId) ? `/records/${outcome.recordId}` : null,
    recordLabel: action === 'closeFree' ? 'View result' : 'View record',
    transactionHref: ['CONFIRMED', 'FINALIZED'].includes(outcome.state) ? transactionHref(outcome.signature, mode) : null };
}
