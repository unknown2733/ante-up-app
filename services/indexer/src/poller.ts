import type { ChainEvent } from './index.ts';
import type { FinalizedEvidence, FinalizedRpc, SignatureInfo } from './rpc.ts';
import { SqliteProjectionStore, type StreamKey } from './sqlite.ts';

/** Supplied by B's generated IDL/Codama client. A missing decoder is a hard error. */
export interface ProgramEventDecoder {
  decodeFinalized(evidence: FinalizedEvidence, scope: StreamKey): Promise<ChainEvent[]>;
}
export const missingProgramDecoder: ProgramEventDecoder = {
  async decodeFinalized() { throw new Error('GENERATED_PROGRAM_DECODER_REQUIRED'); }
};

export type PollResult = { state: 'idle' | 'scanning' | 'applied'; pending: number; events: number; headSignature: string | null };

/** One durable page per call. Cursor advances only after every new finalized transaction decodes and projects. */
export class FinalizedPoller {
  private store: SqliteProjectionStore;
  private rpc: FinalizedRpc;
  private decoder: ProgramEventDecoder;
  private pageSize: number;
  private beforePoll?: (key: StreamKey) => Promise<void>;
  constructor(store: SqliteProjectionStore, rpc: FinalizedRpc, decoder: ProgramEventDecoder, pageSize = 100,
    beforePoll?: (key: StreamKey) => Promise<void>) {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('INVALID_PAGE_SIZE');
    this.store = store; this.rpc = rpc; this.decoder = decoder; this.pageSize = pageSize; this.beforePoll = beforePoll;
  }
  async pollOnce(key: StreamKey): Promise<PollResult> {
    await this.beforePoll?.(key);
    let cursor = this.store.cursor(key);
    if (!cursor.scanHead || cursor.scanBefore !== null) {
      const page = await this.rpc.listSignatures(key.address, cursor.scanBefore, this.pageSize);
      this.validatePage(page, cursor.scanBefore);
      if (!page.length && !cursor.scanHead) return { state: 'idle', pending: 0, events: 0, headSignature: cursor.headSignature };
      const stopAt = cursor.headSignature;
      const stopIndex = stopAt ? page.findIndex(item => item.signature === stopAt) : -1;
      const newer = stopIndex >= 0 ? page.slice(0, stopIndex) : page;
      const complete = stopIndex >= 0 || page.length < this.pageSize;
      if (complete && stopAt && stopIndex < 0) throw new Error('HISTORY_GAP');
      const scanHead = cursor.scanHead ?? page[0]?.signature ?? stopAt;
      if (!scanHead) return { state: 'idle', pending: 0, events: 0, headSignature: null };
      this.store.savePage(key, newer.map(item => ({ signature: item.signature, slot: item.slot, failed: item.failed })), scanHead,
        complete ? null : page.at(-1)!.signature);
      cursor = this.store.cursor(key);
      if (!complete) return { state: 'scanning', pending: this.store.pending(key).length, events: 0, headSignature: cursor.headSignature };
    }
    const pending = this.store.pending(key);
    const evidence: FinalizedEvidence[] = [];
    for (const item of pending) {
      if (item.failed) continue;
      evidence.push(await this.rpc.getEvidence(item.signature, item.slot));
    }
    evidence.sort((a, b) => {
      const slotOrder = BigInt(a.slot) < BigInt(b.slot) ? -1 : BigInt(a.slot) > BigInt(b.slot) ? 1 : 0;
      return slotOrder || a.transactionIndex - b.transactionIndex;
    });
    const events: ChainEvent[] = [];
    for (const item of evidence) {
      const decoded = await this.decoder.decodeFinalized(item, key);
      for (const event of decoded) {
        if (event.cluster !== key.cluster || event.programId !== key.programId || event.signature !== item.signature || event.slot !== item.slot || event.transactionIndex !== item.transactionIndex || event.finality !== 'finalized') throw new Error('DECODED_EVENT_PROVENANCE_MISMATCH');
        events.push(event);
      }
    }
    this.store.commitScan(key, events, cursor.scanHead!);
    return { state: 'applied', pending: 0, events: events.length, headSignature: cursor.scanHead };
  }
  private validatePage(page: SignatureInfo[], before: string | null): void {
    const seen = new Set<string>();
    for (const item of page) {
      if (!item.signature || item.signature === before || seen.has(item.signature) || !/^(0|[1-9][0-9]*)$/.test(item.slot)) throw new Error('INVALID_SIGNATURE_PAGE');
      seen.add(item.signature);
    }
  }
}
