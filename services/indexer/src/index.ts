import type { FreeRecord, Operation, PublishedSnapshot, RecordPoint } from '../../../contracts/types.ts';

export interface ChainEvent {
  cluster: 'localnet' | 'devnet';
  programId: string;
  signature: string;
  eventIndex: number;
  /** Canonical transaction index in the slot; required when signatures share a slot. */
  transactionIndex?: number;
  slot: string;
  finality: 'confirmed' | 'finalized';
  kind: 'freeRecord' | 'snapshot' | 'proofLink';
  record?: FreeRecord;
  snapshot?: PublishedSnapshot;
  recordId?: string;
  proofId?: string;
}

export const eventKey = (e: ChainEvent): string =>
  `${e.cluster}:${e.programId}:${e.signature}:${e.eventIndex}`;

/** A confirmed event is provisional; the finalized copy wins, keyed by chain identity. */
export class EventIndex {
  private events = new Map<string, ChainEvent>();

  ingest(e: ChainEvent): boolean {
    if (!Number.isSafeInteger(e.eventIndex) || e.eventIndex < 0 || !/^(0|[1-9][0-9]*)$/.test(e.slot)) throw new Error('INVALID_INPUT');
    if (e.transactionIndex !== undefined && (!Number.isSafeInteger(e.transactionIndex) || e.transactionIndex < 0)) throw new Error('INVALID_INPUT');
    if ((e.kind === 'freeRecord' && !e.record) || (e.kind === 'snapshot' && !e.snapshot) || (e.kind === 'proofLink' && (!e.recordId || !e.proofId))) throw new Error('INVALID_INPUT');
    const key = eventKey(e);
    const old = this.events.get(key);
    if (old?.finality === 'finalized') return false;
    if (old && BigInt(e.slot) < BigInt(old.slot)) return false;
    this.events.set(key, structuredClone(e));
    return true;
  }

  finalizedRecords(): FreeRecord[] {
    return this.projectRecords([...this.events.values()].filter(e => e.finality === 'finalized' && (e.kind === 'freeRecord' || e.kind === 'proofLink')));
  }

  /** Replay exactly through a transaction/event cursor. Missing same-slot order fails closed. */
  finalizedRecordsAt(cursor: { slot: string; transactionIndex: number; eventIndex: number }): FreeRecord[] {
    if (!/^(0|[1-9][0-9]*)$/.test(cursor.slot) || !Number.isSafeInteger(cursor.transactionIndex) || cursor.transactionIndex < 0 || !Number.isSafeInteger(cursor.eventIndex) || cursor.eventIndex < 0) throw new Error('INVALID_INPUT');
    const events = [...this.events.values()].filter(e => {
      if (e.finality !== 'finalized' || (e.kind !== 'freeRecord' && e.kind !== 'proofLink')) return false;
      if (BigInt(e.slot) < BigInt(cursor.slot)) return true;
      if (BigInt(e.slot) > BigInt(cursor.slot)) return false;
      if (e.transactionIndex === undefined) throw new Error('MISSING_TRANSACTION_ORDER');
      return e.transactionIndex < cursor.transactionIndex || (e.transactionIndex === cursor.transactionIndex && e.eventIndex <= cursor.eventIndex);
    });
    return this.projectRecords(events);
  }

  private projectRecords(events: ChainEvent[]): FreeRecord[] {
    const byRecord = new Map<string, ChainEvent[]>();
    for (const event of events) {
      const key = JSON.stringify([event.cluster, event.programId, event.record?.id ?? event.recordId]);
      const list = byRecord.get(key) ?? [];
      list.push(event);
      byRecord.set(key, list);
    }
    const current: FreeRecord[] = [];
    for (const list of byRecord.values()) {
      list.sort((a, b) => {
        const slotOrder = BigInt(a.slot) < BigInt(b.slot) ? -1 : BigInt(a.slot) > BigInt(b.slot) ? 1 : 0;
        if (slotOrder) return slotOrder;
        if (a.signature === b.signature) return a.eventIndex - b.eventIndex;
        if (a.transactionIndex === undefined || b.transactionIndex === undefined) throw new Error('AMBIGUOUS_CHAIN_ORDER');
        if (a.transactionIndex === b.transactionIndex) throw new Error('AMBIGUOUS_CHAIN_ORDER');
        return a.transactionIndex - b.transactionIndex;
      });
      let projected: FreeRecord | null = null;
      for (const event of list) {
        if (event.kind === 'proofLink') {
          if (!projected) throw new Error('ORPHAN_PROOF_LINK');
          projected = { ...(projected as FreeRecord), proofId: event.proofId! };
          continue;
        }
        const incoming = event.record!;
        if (projected === null) {
          if (incoming.status && incoming.status !== 'OPEN') throw new Error('ORPHAN_CLOSE');
          projected = structuredClone(incoming); continue;
        }
        if (projected.wallet !== incoming.wallet || projected.marketId !== incoming.marketId) throw new Error('RECORD_ID_COLLISION');
        if (projected.status === 'OPEN') {
          if (incoming.status === 'OPEN') {
            if (JSON.stringify(incoming.entry) !== JSON.stringify(projected.entry)) throw new Error('CONFLICTING_RECORD_ENTRY');
            projected = { ...projected, proofId: incoming.proofId ?? projected.proofId };
          } else {
            const historicalEntry: RecordPoint = projected.entry;
            if (historicalEntry.executedAt !== incoming.entry.executedAt || historicalEntry.slot !== incoming.entry.slot || JSON.stringify(historicalEntry.snapshot) !== JSON.stringify(incoming.entry.snapshot) || JSON.stringify(historicalEntry.h) !== JSON.stringify(incoming.entry.h) || historicalEntry.unavailableReason !== incoming.entry.unavailableReason) throw new Error('CONFLICTING_RECORD_ENTRY');
            projected = { ...structuredClone(incoming), entry: historicalEntry };
          }
        } else {
          if (incoming.status !== projected.status || JSON.stringify(incoming.result) !== JSON.stringify(projected.result) || JSON.stringify(incoming.exit) !== JSON.stringify(projected.exit)) throw new Error('CONFLICTING_TERMINAL_RECORD');
          projected = { ...projected, proofId: incoming.proofId ?? projected.proofId };
        }
      }
      if (projected) current.push({ ...projected, finality: 'finalized' });
    }
    return current.sort((a, b) => a.id.localeCompare(b.id));
  }

  finalizedSnapshots(): PublishedSnapshot[] {
    return [...this.events.values()]
      .filter(e => e.finality === 'finalized' && e.kind === 'snapshot')
      .map(e => ({ ...structuredClone(e.snapshot!), finality: 'finalized' }));
  }
}

export type OperationKey = { wallet: string; action: string; requestId: string };
export const operationKey = (k: OperationKey) => JSON.stringify([k.wallet, k.action, k.requestId]);

export class OperationStore {
  private byKey = new Map<string, Operation>();
  private requestOwners = new Map<string, string>();

  create(input: OperationKey): Operation {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) throw new Error('INVALID_INPUT');
    const key = operationKey(input);
    const owner = this.requestOwners.get(input.requestId);
    if (owner && owner !== key) throw new Error('ALREADY_EXECUTED');
    const existing = this.byKey.get(key);
    if (existing) return structuredClone(existing);
    const value: Operation = { ...input, signature: null, state: 'AWAITING_SIGNATURE', error: null };
    this.byKey.set(key, value);
    this.requestOwners.set(input.requestId, key);
    return structuredClone(value);
  }

  get(requestId: string): Operation | null {
    const key = this.requestOwners.get(requestId);
    return key ? structuredClone(this.byKey.get(key)!) : null;
  }

  update(requestId: string, state: Operation['state'], signature: string | null = null): Operation {
    const key = this.requestOwners.get(requestId);
    if (!key) throw new Error('INVALID_INPUT');
    const old = this.byKey.get(key)!;
    if (old.state === 'FINALIZED' && state !== 'FINALIZED') throw new Error('ALREADY_EXECUTED');
    if (state === 'FINALIZED' && !signature && !old.signature) throw new Error('INVALID_INPUT');
    const next = { ...old, state, signature: signature ?? old.signature };
    this.byKey.set(key, next);
    return structuredClone(next);
  }
}

export interface ChainLookup {
  bySignature(signature: string): Promise<'confirmed' | 'finalized' | 'failed' | null>;
  byContractId(wallet: string, action: string, requestId: string): Promise<{ signature: string; finality: 'confirmed' | 'finalized' } | null>;
}

/** Unknown RPC outcomes are reconciled before any new submission is permitted. */
export async function reconcileUnknown(store: OperationStore, requestId: string, lookup: ChainLookup): Promise<Operation> {
  const operation = store.get(requestId);
  if (!operation || operation.state !== 'UNKNOWN') throw new Error('INVALID_INPUT');
  const bySig = operation.signature ? await lookup.bySignature(operation.signature) : null;
  if (bySig === 'finalized') return store.update(requestId, 'FINALIZED');
  if (bySig === 'confirmed') return store.update(requestId, 'CONFIRMED');
  if (bySig === 'failed') return store.update(requestId, 'FAILED');
  const byContract = await lookup.byContractId(operation.wallet, operation.action, requestId);
  if (byContract) return store.update(requestId, byContract.finality === 'finalized' ? 'FINALIZED' : 'CONFIRMED', byContract.signature);
  // An RPC miss cannot prove absence; preserve UNKNOWN for later reconciliation.
  return operation;
}
