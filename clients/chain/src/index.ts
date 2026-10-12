/** Public Kit/IDL boundary for API, indexer and web consumers. */
export * from './generated/index.js';
export * from './runtime.js';

import {
  AnteUpEvent,
  fetchFreeRecord,
  fetchMarket,
  fetchSnapshot,
  identifyAnteUpEvent,
  parseFreeClosedEvent,
  parseFreeOpenedEvent,
  parseProofCompletedEvent,
  parseSnapshotPublishedEvent,
} from './generated/index.js';

/** Accept only bytes attributed to this program in a finalized transaction. */
export function decodeAnteUpEvent(data: Uint8Array) {
  switch (identifyAnteUpEvent(data)) {
    case AnteUpEvent.FreeOpened:
      return {kind: 'freeOpened' as const, value: parseFreeOpenedEvent(data)};
    case AnteUpEvent.FreeClosed:
      return {kind: 'freeClosed' as const, value: parseFreeClosedEvent(data)};
    case AnteUpEvent.ProofCompleted:
      return {kind: 'proofCompleted' as const, value: parseProofCompletedEvent(data)};
    case AnteUpEvent.SnapshotPublished:
      return {kind: 'snapshotPublished' as const, value: parseSnapshotPublishedEvent(data)};
  }
}

/** Account reads for current state. Historical event projection uses event bytes. */
export function fetchFinalizedFreeRecord(
  rpc: Parameters<typeof fetchFreeRecord>[0],
  address: Parameters<typeof fetchFreeRecord>[1],
) {
  return fetchFreeRecord(rpc, address, {commitment: 'finalized'});
}
export function fetchFinalizedMarket(
  rpc: Parameters<typeof fetchMarket>[0],
  address: Parameters<typeof fetchMarket>[1],
) {
  return fetchMarket(rpc, address, {commitment: 'finalized'});
}
export function fetchFinalizedSnapshot(
  rpc: Parameters<typeof fetchSnapshot>[0],
  address: Parameters<typeof fetchSnapshot>[1],
) {
  return fetchSnapshot(rpc, address, {commitment: 'finalized'});
}

export {
  getOpenFreeInstructionAsync as buildOpenFreeInstruction,
  getCloseFreeInstructionAsync as buildCloseFreeInstruction,
  getPublishSnapshotInstructionAsync as buildPublishSnapshotInstruction,
} from './generated/index.js';
