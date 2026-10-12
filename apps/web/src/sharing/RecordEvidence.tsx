import type { FreeRecord, Mode, ProofStatus } from '../../../../contracts/types';
import { evidenceLinks, proofIsVerified, recordProof } from './proofLinks';
import './proofEvidence.css';

const pendingLabels: Record<ProofStatus['state'], string> = { QUEUED: 'Evidence is queued', UPLOADED: 'Evidence uploaded; verification pending', CONFIRMING: 'Waiting for storage confirmations', READY_TO_ISSUE: 'Storage verified; attestation pending', ISSUED: 'Attestation issued', INVALID: 'Proof invalid', REPLACED: 'Proof replaced' };
export function RecordEvidence({ record, proof, mode, loading = false, unavailable = false }: { record: FreeRecord; proof: ProofStatus | null; mode: Mode | null; loading?: boolean; unavailable?: boolean }) {
  const currentProof = loading || unavailable ? null : proof;
  const matched = recordProof(record, currentProof);
  const verified = record.finality === 'finalized' && record.status !== 'OPEN' && !!record.exit && proofIsVerified(matched) && mode === 'devnet';
  const links = evidenceLinks(record, currentProof, mode);
  const transactions = links.filter(link => !link.hash);
  const artifacts = links.filter(link => link.hash);
  const status = mode === 'fixture' ? 'Sample record — no external proof' : record.finality !== 'finalized' ? 'Waiting for final chain confirmation' : record.status === 'OPEN' ? 'Placement recorded; result proof follows after taking back' : loading ? 'Checking proof status…' : unavailable ? 'Proof status unavailable — retry later' : verified ? 'SAS issued · evidence verified' : matched && matched.state !== 'ISSUED' ? pendingLabels[matched.state] : 'Proof pending';
  return <section className="au-proof-links" aria-label="Verify this record">
    <div className="au-proof-heading"><div><span className="eyebrow">ON THE RECORD</span><h2>Verify your chip</h2></div><span className={`au-proof-badge${verified ? ' au-proof-verified' : ''}`} role="status">{status}</span></div>
    <p>Your chip result and its archived proof finish separately. Transaction links show the recorded actions.</p>
    {!!transactions.length && <div className="au-proof-transactions">{transactions.map(link => <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer">{link.label} ↗</a>)}</div>}
    {!verified && record.status !== 'OPEN' && mode === 'devnet' && <p className="au-proof-pending">{matched?.confirmations != null && Number.isSafeInteger(matched.confirmations) && matched.confirmations >= 0 ? `${matched.confirmations} / 20 storage confirmations. ` : ''}Source and calculation links become available after the proof passes validation.</p>}
    {!!artifacts.length && <details className="au-proof-artifacts"><summary>Source data and calculation evidence · {artifacts.length - 1} artifacts</summary><p>The manifest binds this record to the archived inputs and calculation evidence. Artifact types are described inside the files.</p>{artifacts.map((link, index) => <div key={`${link.href}:${index}`}><a href={link.href} target="_blank" rel="noopener noreferrer">{link.label} ↗</a><code title={link.hash!}>SHA-256 {link.hash}</code></div>)}</details>}
    {matched?.state === 'REPLACED' && matched.replacementId && <a className="text-link" href={`/proofs/${encodeURIComponent(matched.replacementId)}`}>View replacement proof ↗</a>}
  </section>;
}
