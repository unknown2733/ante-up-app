import type { Mode } from '../../../../contracts/types';
import type { FreeOutcome } from '../liveFree';
import { isChainAddress, transactionHref } from './proofLinks.ts';

export function executionResult(outcome: FreeOutcome, action: 'openFree' | 'closeFree', mode: Mode | null) {
  const finalized = outcome.state === 'FINALIZED';
  const pending = ['UNKNOWN', 'SUBMITTED', 'CONFIRMED', 'BUSY', 'AWAITING_SIGNATURE'].includes(outcome.state);
  const expired = outcome.state === 'FAILED' && /expir|requote/i.test(outcome.reason ?? '');
  const cancelled = outcome.state === 'FAILED' && /cancel|reject|declin/i.test(outcome.reason ?? '');
  const title = finalized ? action === 'closeFree' ? 'Chip taken back.' : 'Your chip is placed.' : pending ? 'Your request is not final yet.' : expired ? 'Request expired.' : cancelled ? 'Request cancelled.' : 'Chip action did not complete.';
  const description = finalized ? action === 'closeFree' ? 'Your result is recorded. Open it to create a result card and follow proof issuance.' : 'The placement is on chain. Open your record to follow the result.' : pending ? 'Check the existing request before starting another one. A wallet approval alone does not confirm execution.' : 'No successful chip action is confirmed here. Review the request status before retrying.';
  return { title, description, finalized, pending,
    recordHref: finalized && mode === 'devnet' && isChainAddress(outcome.recordId) ? `/records/${outcome.recordId}` : null,
    recordLabel: action === 'closeFree' ? 'View result' : 'View record',
    transactionHref: ['CONFIRMED', 'FINALIZED'].includes(outcome.state) ? transactionHref(outcome.signature, mode) : null };
}
