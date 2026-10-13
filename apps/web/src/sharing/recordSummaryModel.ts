import type { FreeRecord, Mode, ProofStatus } from '../../../../contracts/types';
import { proofIsVerified, recordProof } from './proofLinks';

/** Exact rational rounding. Preserve small nonzero directions instead of rendering -0.0%. */
export function summaryResult(record: FreeRecord): string {
  if (record.status === 'OPEN') return 'Active';
  if (record.status !== 'CLOSED_RESULT' || record.result?.kind !== 'return') return 'N/A';
  try {
    const n = BigInt(record.result.numerator), d = BigInt(record.result.denominator);
    if (d <= 0n) return 'N/A';
    if (n === 0n) return '0.00%';
    const sign = n < 0n ? '−' : '+';
    const magnitude = n < 0n ? -n : n;
    for (let digits = 2; digits <= 4; digits++) {
      const scale = 10n ** BigInt(digits);
      const rounded = (magnitude * 100n * scale + d / 2n) / d;
      if (rounded > 0n) return `${sign}${rounded / scale}.${(rounded % scale).toString().padStart(digits, '0')}%`;
    }
    return `${n < 0n ? 'Decrease' : 'Increase'} <0.0001%`;
  } catch { return 'N/A'; }
}

export function summaryProof(record: FreeRecord, proof: ProofStatus | null, mode: Mode | null, loading = false, unavailable = false): string {
  if (mode === 'fixture') return 'Sample record';
  if (record.finality !== 'finalized') return 'Chain confirmation pending';
  if (record.status === 'OPEN') return 'Entry recorded';
  if (loading) return 'Checking proof…';
  if (unavailable) return 'Proof status unavailable';
  const matched = recordProof(record, proof);
  if (matched?.state === 'INVALID') return 'Proof invalid';
  if (matched?.state === 'REPLACED') return 'Proof replaced';
  return mode === 'devnet' && !!record.exit && proofIsVerified(matched) ? 'SAS issued · verified' : 'Proof pending';
}
