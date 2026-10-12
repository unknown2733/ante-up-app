import { decodeAnteUpEvent, FreeState, NaReason, type RecordPoint as ChainRecordPoint } from '../../../clients/chain/dist/index.js';
import type { FreeRecord, RecordPoint, SnapshotCandidate } from '../../../contracts/types.ts';
import type { ChainEvent } from './index.ts';
import type { ProgramEventDecoder } from './poller.ts';
import type { FinalizedEvidence } from './rpc.ts';
import type { SnapshotAccountView } from './snapshot.ts';
import { verifyPublishedSnapshot } from './snapshot.ts';
import type { StreamKey } from './sqlite.ts';

const hex = (bytes: ArrayLike<number>) => Buffer.from(Uint8Array.from(bytes)).toString('hex');
const unix = (value: bigint): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('INVALID_CHAIN_TIME');
  return number;
};
const reasonName = (reason: NaReason): string => {
  const name = NaReason[reason];
  if (!name) throw new Error('UNKNOWN_NA_REASON');
  return name;
};
function point(value: ChainRecordPoint, market: string, signature: string): RecordPoint {
  if (value.usable && (value.hDen === 0n || value.reason !== NaReason.None)) throw new Error('INVALID_RECORD_POINT');
  if (!value.usable && value.reason === NaReason.None) throw new Error('INVALID_RECORD_POINT');
  return {
    executedAt: unix(value.executedAt), slot: value.slot.toString(), signature,
    snapshot: value.sequence === 0n ? null : {marketId: market, sequence: value.sequence.toString(), payloadHash: hex(value.payloadHash)},
    h: value.usable ? {numerator: value.hNum.toString(), denominator: value.hDen.toString()} : null,
    unavailableReason: value.usable ? null : reasonName(value.reason),
  };
}

/** Source of immutable, hash-matched C candidates and B Snapshot accounts. */
export interface SnapshotResolver {
  resolve(input: {marketAddress: string; sequence: string; payloadHash: string; scope: StreamKey}): Promise<{
    marketId: string; candidate: SnapshotCandidate; account: SnapshotAccountView;
  }>;
}
/** Evidence job lookup binds the on-chain payload hash to the public proof ID. */
export interface ProofResolver {
  resolve(input: {recordAddress: string; proofHash: string; scope: StreamKey}): Promise<string>;
}

/** Decodes Anchor event bytes only while the target program owns the invocation frame. */
export class GeneratedProgramEventDecoder implements ProgramEventDecoder {
  private readonly snapshots?: SnapshotResolver;
  private readonly proofs?: ProofResolver;
  constructor(options: {snapshots?: SnapshotResolver; proofs?: ProofResolver} = {}) {
    this.snapshots = options.snapshots; this.proofs = options.proofs;
  }
  async decodeFinalized(evidence: FinalizedEvidence, scope: StreamKey): Promise<ChainEvent[]> {
    const meta = evidence.meta as {logMessages?: unknown} | null;
    if (!meta || !Array.isArray(meta.logMessages) || !meta.logMessages.every(x => typeof x === 'string')) throw new Error('FINALIZED_LOGS_UNAVAILABLE');
    const stack: string[] = [];
    const events: ChainEvent[] = [];
    for (const [logIndex, log] of meta.logMessages.entries()) {
      const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[([1-9][0-9]*)\]$/.exec(log);
      if (invoke) {
        const depth = Number(invoke[2]);
        if (depth !== stack.length + 1) throw new Error('INVALID_PROGRAM_LOG_STACK');
        stack.push(invoke[1]);
        continue;
      }
      const end = /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed: .*)$/.exec(log);
      if (end) {
        if (stack.pop() !== end[1]) throw new Error('INVALID_PROGRAM_LOG_STACK');
        continue;
      }
      if (!log.startsWith('Program data: ') || stack.at(-1) !== scope.programId) continue;
      const base64 = log.slice('Program data: '.length);
      const bytes = Buffer.from(base64, 'base64');
      if (!base64 || bytes.toString('base64') !== base64) throw new Error('INVALID_EVENT_ENCODING');
      const decoded = decodeAnteUpEvent(bytes);
      if (!decoded) continue;
      const base = {
        cluster: scope.cluster, programId: scope.programId, signature: evidence.signature,
        slot: evidence.slot, transactionIndex: evidence.transactionIndex, eventIndex: logIndex,
        finality: 'finalized' as const,
      };
      if (decoded.kind === 'freeOpened') {
        const v = decoded.value;
        const record: FreeRecord = { id: String(v.record), wallet: String(v.owner), marketId: String(v.market), direction: 'up',
          entry: point(v.entry, String(v.market), evidence.signature), exit: null, status: 'OPEN', result: null, finality: 'finalized', proofId: null };
        events.push({...base, kind: 'freeRecord', record});
      } else if (decoded.kind === 'freeClosed') {
        const v = decoded.value;
        if (v.state === FreeState.Open) throw new Error('INVALID_CLOSE_STATE');
        const result = v.state === FreeState.ClosedResult
          ? {kind: 'return' as const, numerator: `${v.resultNegative ? '-' : ''}${v.resultNum}`, denominator: v.resultDen.toString()}
          : {kind: 'na' as const, reason: reasonName(v.naReason)};
        if (v.state === FreeState.ClosedResult && (v.resultDen === 0n || v.naReason !== NaReason.None)) throw new Error('INVALID_CLOSE_RESULT');
        const record: FreeRecord = { id: String(v.record), wallet: String(v.owner), marketId: String(v.market), direction: 'up',
          entry: point(v.entry, String(v.market), ''), exit: point(v.exit, String(v.market), evidence.signature),
          status: v.state === FreeState.ClosedResult ? 'CLOSED_RESULT' : 'CLOSED_NA', result, finality: 'finalized', proofId: null };
        events.push({...base, kind: 'freeRecord', record});
      } else if (decoded.kind === 'proofCompleted') {
        if (!this.proofs) throw new Error('PROOF_RESOLVER_REQUIRED');
        const v = decoded.value;
        const proofId = await this.proofs.resolve({recordAddress: String(v.record), proofHash: hex(v.proofHash), scope});
        if (!proofId) throw new Error('PROOF_ID_UNRESOLVED');
        events.push({...base, kind: 'proofLink', recordId: String(v.record), proofId});
      } else {
        if (!this.snapshots) throw new Error('SNAPSHOT_RESOLVER_REQUIRED');
        const v = decoded.value;
        const marketAddress = String(v.market), sequence = v.sequence.toString(), payloadHash = hex(v.payloadHash);
        const resolved = await this.snapshots.resolve({marketAddress, sequence, payloadHash, scope});
        const snapshot = verifyPublishedSnapshot({cluster: scope.cluster, programId: scope.programId,
          signature: evidence.signature, slot: evidence.slot, marketAddress, marketId: resolved.marketId,
          sequence, eventPayloadHash: payloadHash, candidate: resolved.candidate, account: resolved.account});
        events.push({...base, kind: 'snapshot', snapshot});
      }
    }
    if (stack.length) throw new Error('INVALID_PROGRAM_LOG_STACK');
    return events;
  }
}

/** Safe default for CLI wiring: unresolved sparse events stop cursor advancement. */
export const decoder = new GeneratedProgramEventDecoder();
