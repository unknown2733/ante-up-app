import { getBase58Encoder } from '@solana/kit';
import type { EvidenceRef, FreeRecord, Mode, ProofStatus } from '../../../../contracts/types';

function base58Bytes(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
  try { return getBase58Encoder().encode(value).length === length; } catch { return false; }
}
export const isChainAddress = (value: unknown): value is string => base58Bytes(value, 32);
export const isTransactionSignature = (value: unknown): value is string => base58Bytes(value, 64);
export const isArweaveId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function transactionHref(signature: unknown, mode: Mode | null): string | null {
  return mode === 'devnet' && isTransactionSignature(signature) ? `https://explorer.solana.com/tx/${signature}?cluster=devnet` : null;
}
export interface EvidenceLink { label: string; href: string; hash: string | null }
const completeRef = (ref: EvidenceRef | null | undefined): ref is EvidenceRef => !!ref && /^[a-f0-9]{64}$/.test(ref.contentHash) && isArweaveId(ref.arweaveItemId) && isArweaveId(ref.parentTransactionId);
export function proofIsVerified(proof: ProofStatus | null | undefined): boolean {
  return !!proof && proof.state === 'ISSUED' && isChainAddress(proof.sasId) && Number.isInteger(proof.confirmations) && proof.confirmations! >= 20 &&
    /^[a-f0-9]{64}$/.test(proof.payloadHash ?? '') && completeRef(proof.manifestRef) && proof.manifestRef.contentHash === proof.payloadHash && Array.isArray(proof.evidence) && proof.evidence.length > 0 && proof.evidence.every(completeRef);
}
export function recordProof(record: FreeRecord | null | undefined, proof: ProofStatus | null | undefined): ProofStatus | null {
  return record && proof && record.proofId === proof.id && record.id === proof.recordId ? proof : null;
}
/** Link validation is presentation gating; cryptographic and chain validation belongs to the API/worker. */
export function evidenceLinks(record: FreeRecord | null, proof: ProofStatus | null, mode: Mode | null): EvidenceLink[] {
  if (mode !== 'devnet') return [];
  const links: EvidenceLink[] = [];
  if (record?.finality === 'finalized') {
    const entry = transactionHref(record.entry.signature, mode);
    const exit = record.exit && transactionHref(record.exit.signature, mode);
    if (entry) links.push({ label: 'Placement transaction', href: entry, hash: null });
    if (exit) links.push({ label: 'Return transaction', href: exit, hash: null });
  }
  const matched = recordProof(record, proof);
  if (!matched || record?.finality !== 'finalized' || record.status === 'OPEN' || !record.exit || !proofIsVerified(matched)) return links;
  links.push({ label: 'SAS attestation', href: `https://explorer.solana.com/address/${matched.sasId}?cluster=devnet`, hash: null });
  links.push({ label: 'Evidence manifest', href: `https://arweave.net/${matched.manifestRef!.arweaveItemId}`, hash: matched.manifestRef!.contentHash });
  matched.evidence.forEach((ref, index) => links.push({ label: `Source / calculation artifact ${index + 1}`, href: `https://arweave.net/${ref.arweaveItemId}`, hash: ref.contentHash }));
  return links;
}
