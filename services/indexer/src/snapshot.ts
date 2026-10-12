import type { PublishedSnapshot, SnapshotCandidate } from '../../../contracts/types.ts';
import { FORMULA_VERSION } from '../../../contracts/types.ts';
import { hash as canonicalHash } from '../../data/index.mjs';
import { AdmissionReason, AdmissionState, DataStatus, type Snapshot as ChainSnapshot } from '../../../clients/chain/dist/index.js';

/** Normalized from B's generated immutable Snapshot account decoder. */
export interface SnapshotAccountView {
  address: string; ownerProgramId: string; marketAddress: string;
  sequence: string; payloadHash: string; evidenceHash: string; queryHash: string;
  queryVersion: string; configVersion: string; formulaVersion: string;
  dataThrough: number; publishedAt: number;
  activityNowQ12: string | null; activity7dQ12: string | null;
  dataStatus: SnapshotCandidate['dataStatus']; admission: SnapshotCandidate['admission'];
}
const option = <T>(value: {__option: 'Some'; value: T} | {__option: 'None'}): T | null => value.__option === 'Some' ? value.value : null;
const reason = (value: AdmissionReason | null): SnapshotCandidate['admission']['reason'] => {
  if (value === null) return null;
  const name = AdmissionReason[value];
  if (!name) throw new Error('UNKNOWN_ADMISSION_REASON');
  return name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase() as SnapshotCandidate['admission']['reason'];
};

/** Normalize B's generated account after the resolver verifies its RPC owner and PDA. */
export function snapshotViewFromGenerated(account: ChainSnapshot, address: string, ownerProgramId: string): SnapshotAccountView {
  const formulaVersion = new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(account.formulaVersion)).replace(/\0+$/, '');
  const state = ({[AdmissionState.Blocked]: 'BLOCKED', [AdmissionState.Recovering]: 'RECOVERING', [AdmissionState.Open]: 'OPEN'} as const)[account.admission.state];
  const dataStatus = ({[DataStatus.Preparing]: 'PREPARING', [DataStatus.Valid]: 'VALID', [DataStatus.LowActivity]: 'LOW_ACTIVITY', [DataStatus.Outage]: 'OUTAGE'} as const)[account.dataStatus];
  if (!state || !dataStatus || ![0, 1, 2].includes(account.admission.recoveryCount)) throw new Error('UNKNOWN_SNAPSHOT_ENUM');
  return {
    address, ownerProgramId, marketAddress: String(account.market), sequence: account.sequence.toString(),
    payloadHash: Buffer.from(Uint8Array.from(account.payloadHash)).toString('hex'),
    evidenceHash: Buffer.from(Uint8Array.from(account.evidenceHash)).toString('hex'),
    queryHash: Buffer.from(Uint8Array.from(account.queryHash)).toString('hex'),
    queryVersion: account.queryVersion.toString(), configVersion: account.configVersion.toString(), formulaVersion,
    dataThrough: Number(account.dataThrough), publishedAt: Number(account.publishedAt),
    activityNowQ12: option(account.activityNowQ12)?.toString() ?? null,
    activity7dQ12: option(account.activity7dQ12)?.toString() ?? null,
    dataStatus, admission: {state, recoveryCount: account.admission.recoveryCount as 0 | 1 | 2, reason: reason(option(account.admission.reason))},
  };
}

/** The event alone is sparse; only a hash-matched C candidate plus B account becomes a public snapshot. */
export function verifyPublishedSnapshot(input: {
  cluster: 'localnet' | 'devnet'; programId: string; signature: string; slot: string;
  marketAddress: string; marketId: string; sequence: string; eventPayloadHash: string;
  candidate: SnapshotCandidate; account: SnapshotAccountView;
}): PublishedSnapshot {
  const { candidate, account } = input;
  const hex = /^[0-9a-f]{64}$/;
  if (!hex.test(input.eventPayloadHash) || !hex.test(account.payloadHash) || !hex.test(account.queryHash) || !hex.test(account.evidenceHash)) throw new Error('INVALID_HASH');
  if (canonicalHash(candidate) !== input.eventPayloadHash || account.payloadHash !== input.eventPayloadHash) throw new Error('SNAPSHOT_HASH_MISMATCH');
  if (candidate.schemaVersion !== '0.1' || candidate.formulaVersion !== FORMULA_VERSION || account.formulaVersion !== FORMULA_VERSION) throw new Error('FORMULA_VERSION_MISMATCH');
  if (candidate.marketId !== input.marketId || account.marketAddress !== input.marketAddress || account.ownerProgramId !== input.programId) throw new Error('MARKET_IDENTITY_MISMATCH');
  if (candidate.sequence !== input.sequence || account.sequence !== input.sequence || candidate.queryVersion !== account.queryVersion || candidate.configVersion !== account.configVersion || candidate.queryHash !== account.queryHash || candidate.evidenceHash !== account.evidenceHash) throw new Error('SNAPSHOT_VERSION_MISMATCH');
  if (candidate.dataThrough !== account.dataThrough || candidate.activityNowQ12 !== account.activityNowQ12 || candidate.activity7dQ12 !== account.activity7dQ12 || candidate.dataStatus !== account.dataStatus || candidate.admission.state !== account.admission.state || candidate.admission.recoveryCount !== account.admission.recoveryCount || candidate.admission.reason !== account.admission.reason) throw new Error('SNAPSHOT_FIELDS_MISMATCH');
  if (!Number.isSafeInteger(account.publishedAt) || account.publishedAt < 0 || !/^(0|[1-9][0-9]*)$/.test(input.slot)) throw new Error('INVALID_CHAIN_TIME');
  return { payload: candidate, payloadHash: input.eventPayloadHash,
    chain: { cluster: input.cluster, programId: input.programId, address: account.address },
    signature: input.signature, slot: input.slot, publishedAt: account.publishedAt, finality: 'finalized' };
}
