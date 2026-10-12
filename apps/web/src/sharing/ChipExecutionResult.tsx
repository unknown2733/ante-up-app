import type { Mode } from '../../../../contracts/types';
import type { FreeOutcome } from '../liveFree';
import { executionResult } from './executionResult';
import './proofEvidence.css';

/** Display only: existing flow retains sole responsibility for retries, signing and reconciliation. */
export function ExecutionResult({ outcome, action, mode, onNavigate }: { outcome: FreeOutcome; action: 'openFree' | 'closeFree'; mode: Mode | null; onNavigate?: (href: string) => void }) {
  const model = executionResult(outcome, action, mode);
  return <section className={`au-execution-result${model.finalized ? ' au-execution-success' : ''}`} aria-label="Chip action result">
    <div role="status"><strong>{model.title}</strong><p>{model.description}</p></div>
    <div className="au-proof-transactions">{model.recordHref && <a className="button button-chip" href={model.recordHref} onClick={onNavigate ? event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onNavigate(model.recordHref!); } } : undefined}>{model.recordLabel} ↗</a>}{model.transactionHref && <a href={model.transactionHref} target="_blank" rel="noopener noreferrer">View transaction ↗</a>}</div>
    {model.finalized && !model.recordHref && <p className="tiny muted">The record is still syncing to your activity. Refresh activity to view it.</p>}
    {outcome.requestId && <details><summary>Request details</summary><code>{outcome.requestId}</code></details>}
  </section>;
}
