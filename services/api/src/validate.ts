import { FORMULA_VERSION, type Action, type FreeRecord, type MarketView, type Operation, type ProofStatus } from '../../../contracts/types.ts';

export class InputError extends Error { constructor(message: string) { super(message); this.name = 'InputError'; } }
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new InputError('object required');
  return v as Record<string, unknown>;
};
const string = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.length) throw new InputError(`${name} required`);
  return v;
};
const uint = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) throw new InputError(`${name} must be canonical decimal string`);
  return v;
};
const int = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(v)) throw new InputError(`${name} must be canonical signed decimal string`);
  return v;
};
const seconds = (v: unknown, name: string): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new InputError(`${name} must be Unix seconds`);
  return v as number;
};
const hash = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) throw new InputError(`${name} must be lowercase SHA-256`);
  return v;
};
const oneOf = <T extends string>(v: unknown, values: readonly T[], name: string): T => {
  if (!values.includes(v as T)) throw new InputError(`${name} invalid`);
  return v as T;
};

export function validateMarket(v: unknown): MarketView {
  const m = object(v);
  string(m.id, 'market.id'); string(m.keyword, 'market.keyword');
  if (!Array.isArray(m.aliases) || !m.aliases.every(x => typeof x === 'string')) throw new InputError('market.aliases invalid');
  oneOf(m.phase, ['CURVE', 'GRADUATION_WAIT', 'INDEXED'] as const, 'market.phase');
  oneOf(m.dataStatus, ['PREPARING', 'VALID', 'LOW_ACTIVITY', 'OUTAGE'] as const, 'market.dataStatus');
  if (typeof m.supported !== 'boolean') throw new InputError('market.supported invalid');
  if (m.price !== null) {
    const p = object(m.price);
    oneOf(p.kind, ['curve', 'indexed'] as const, 'price.kind'); uint(p.atoms, 'price.atoms');
    if (typeof p.executable !== 'boolean') throw new InputError('price.executable invalid');
  }
  if (m.snapshot !== null) {
    const s = object(m.snapshot);
    oneOf(s.finality, ['confirmed', 'finalized'] as const, 'snapshot.finality');
    const payload = object(s.payload);
    if (payload.schemaVersion !== '0.1') throw new InputError('snapshot schema mismatch');
    if (payload.marketId !== m.id) throw new InputError('snapshot market mismatch');
    if (payload.formulaVersion !== FORMULA_VERSION) throw new InputError('formula version mismatch');
    uint(payload.queryVersion, 'snapshot.queryVersion');
    hash(payload.queryHash, 'snapshot.queryHash');
    hash(payload.evidenceHash, 'snapshot.evidenceHash');
    const admission = object(payload.admission);
    oneOf(admission.state, ['BLOCKED', 'RECOVERING', 'OPEN'] as const, 'snapshot.admission.state');
    if (![0, 1, 2].includes(admission.recoveryCount as number)) throw new InputError('snapshot.admission.recoveryCount invalid');
    if (admission.reason !== null && typeof admission.reason !== 'string') throw new InputError('snapshot.admission.reason invalid');
    uint(payload.sequence, 'snapshot.sequence'); seconds(payload.dataThrough, 'snapshot.dataThrough');
    uint(s.slot, 'snapshot.slot'); string(s.signature, 'snapshot.signature');
    hash(s.payloadHash, 'snapshot.payloadHash');
  }
  if (m.anchor !== null) {
    const a = object(m.anchor);
    for (const field of ['graduationPriceAtoms', 'graduationNowQ12', 'graduation7dQ12', 'maxPriceAtoms']) uint(a[field], `anchor.${field}`);
  }
  const capabilities = object(m.capabilities);
  for (const [name, value] of Object.entries(capabilities)) {
    const c = object(value);
    if (typeof c.allowed !== 'boolean' || (c.reason !== null && typeof c.reason !== 'string')) throw new InputError(`capability ${name} invalid`);
  }
  return v as MarketView;
}

export function validateRecord(v: unknown): FreeRecord {
  const r = object(v);
  string(r.id, 'record.id'); string(r.wallet, 'record.wallet'); string(r.marketId, 'record.marketId');
  if (r.direction !== 'up') throw new InputError('record.direction invalid');
  const entry = object(r.entry); seconds(entry.executedAt, 'entry.executedAt'); uint(entry.slot, 'entry.slot'); string(entry.signature, 'entry.signature');
  for (const [name, point] of [['entry', entry], ['exit', r.exit]] as const) {
    if (point === null) continue;
    const p = object(point);
    if (p.h !== null) {
      const h = object(p.h); uint(h.numerator, `${name}.h.numerator`);
      if (BigInt(uint(h.denominator, `${name}.h.denominator`)) <= 0n) throw new InputError(`${name} h denominator zero`);
    }
    if (p.snapshot !== null) {
      const ref = object(p.snapshot); string(ref.marketId, `${name}.snapshot.marketId`); uint(ref.sequence, `${name}.snapshot.sequence`);
    }
  }
  if (r.exit !== null) {
    const exit = object(r.exit); seconds(exit.executedAt, 'exit.executedAt'); uint(exit.slot, 'exit.slot'); string(exit.signature, 'exit.signature');
    if ((exit.executedAt as number) < (entry.executedAt as number)) throw new InputError('exit before entry');
  }
  oneOf(r.status, ['OPEN', 'CLOSED_RESULT', 'CLOSED_NA'] as const, 'record.status');
  oneOf(r.finality, ['confirmed', 'finalized'] as const, 'record.finality');
  if (r.status === 'OPEN' && (r.exit !== null || r.result !== null)) throw new InputError('open record has result');
  if (r.status !== 'OPEN' && r.exit === null) throw new InputError('closed record lacks exit');
  if (r.status === 'CLOSED_RESULT') {
    const result = object(r.result);
    if (result.kind !== 'return') throw new InputError('closed result invalid');
    int(result.numerator, 'result.numerator');
    if (BigInt(uint(result.denominator, 'result.denominator')) <= 0n) throw new InputError('zero result denominator');
    if (!entry.h || !object(r.exit).h || BigInt(uint(object(entry.h).numerator, 'entry.h.numerator')) <= 0n) throw new InputError('result requires valid entry and exit h');
  }
  if (r.status === 'CLOSED_NA') {
    const result = object(r.result);
    if (result.kind !== 'na') throw new InputError('N/A result invalid');
    string(result.reason, 'result.reason');
  }
  return v as FreeRecord;
}

export function validateOperation(v: unknown): Operation {
  const o = object(v);
  string(o.requestId, 'operation.requestId'); string(o.wallet, 'operation.wallet'); string(o.action, 'operation.action');
  oneOf(o.state, ['AWAITING_SIGNATURE', 'SUBMITTED', 'CONFIRMED', 'FINALIZED', 'FAILED', 'UNKNOWN'] as const, 'operation.state');
  if (o.signature !== null) string(o.signature, 'operation.signature');
  return v as Operation;
}

export function validateProof(v: unknown): ProofStatus {
  const p = object(v);
  string(p.id, 'proof.id'); string(p.recordId, 'proof.recordId');
  oneOf(p.state, ['QUEUED', 'UPLOADED', 'CONFIRMING', 'READY_TO_ISSUE', 'ISSUED', 'INVALID', 'REPLACED'] as const, 'proof.state');
  if (p.payloadHash !== null) hash(p.payloadHash, 'proof.payloadHash');
  if (p.manifestRef !== null) {
    const ref = object(p.manifestRef);
    hash(ref.contentHash, 'proof.manifestRef.contentHash');
    string(ref.arweaveItemId, 'proof.manifestRef.arweaveItemId');
    string(ref.parentTransactionId, 'proof.manifestRef.parentTransactionId');
  }
  if (p.confirmations !== null && (!Number.isSafeInteger(p.confirmations) || (p.confirmations as number) < 0)) throw new InputError('proof.confirmations invalid');
  if (!Array.isArray(p.evidence)) throw new InputError('proof.evidence invalid');
  for (const [i, item] of p.evidence.entries()) {
    const ref = object(item);
    hash(ref.contentHash, `proof.evidence.${i}.contentHash`);
    if (ref.arweaveItemId !== null) string(ref.arweaveItemId, `proof.evidence.${i}.arweaveItemId`);
    if (ref.parentTransactionId !== null) string(ref.parentTransactionId, `proof.evidence.${i}.parentTransactionId`);
  }
  if (p.state === 'READY_TO_ISSUE' || p.state === 'ISSUED') {
    if (p.payloadHash === null || p.manifestRef === null) throw new InputError('ready proof requires manifest');
    if (object(p.manifestRef).contentHash !== p.payloadHash) throw new InputError('manifest hash mismatch');
    if ((p.confirmations as number | null) === null || (p.confirmations as number) < 20) throw new InputError('ready proof requires 20 confirmations');
    if (p.evidence.length === 0 || p.evidence.some(item => !item.arweaveItemId || !item.parentTransactionId)) throw new InputError('ready proof requires complete evidence refs');
    if (p.state === 'ISSUED') string(p.sasId, 'proof.sasId');
  }
  if (p.replacementId !== null) string(p.replacementId, 'proof.replacementId');
  return v as ProofStatus;
}

export interface ActionBody { wallet: string; action: Action; requestId: string; marketId: string; recordId: string | null }
export function validateActionBody(v: unknown): ActionBody {
  const b = object(v);
  const wallet = string(b.wallet, 'wallet');
  const action = oneOf(b.action, ['registerMarket', 'curveBuy', 'curveSell', 'graduate', 'spotBuy', 'spotSell', 'openFree', 'closeFree', 'openPro', 'closePro', 'finalizeEpoch', 'claim', 'depositLP', 'withdrawLP'] as const, 'action');
  const requestId = string(b.requestId, 'requestId');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new InputError('requestId must be UUID');
  const recordId = b.recordId === undefined || b.recordId === null ? null : string(b.recordId, 'recordId');
  if (action === 'closeFree' && !recordId) throw new InputError('closeFree recordId required');
  if (action === 'openFree' && recordId) throw new InputError('openFree recordId is generated by the chain builder');
  return { wallet, action, requestId, marketId: string(b.marketId, 'marketId'), recordId };
}
