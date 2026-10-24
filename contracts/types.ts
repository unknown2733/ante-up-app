/** A contract revision 0.2. Wire schema remains 0.1 during pre-release integration. */
export const CONTRACT_REVISION = '0.2' as const;
export const FORMULA_VERSION = 'h3-d7-q12-v1' as const;
export type UInt = string; // canonical decimal: /^(0|[1-9][0-9]*)$/
export type Int = string;
export type Hash = string; // lowercase SHA-256 hex, 64 characters
export type UnixSeconds = number;
export type Mode = 'fixture' | 'localnet' | 'devnet';
export type ChainRef = { cluster: 'localnet' | 'devnet'; programId: string; address: string };
export type VersionSet = { schemaVersion: '0.1'; formulaVersion: string; configVersion: UInt; queryVersion: UInt };
export type DataStatus = 'PREPARING' | 'VALID' | 'LOW_ACTIVITY' | 'OUTAGE';
export type Phase = 'CURVE' | 'GRADUATION_WAIT' | 'INDEXED';
export type EpochPhase = 'INITIAL_LP' | 'PRO_OPEN' | 'OPEN_CUTOFF' | 'SETTLING' | 'LP_WINDOW';
export type Action = 'registerMarket' | 'curveBuy' | 'curveSell' | 'graduate' | 'spotBuy' | 'spotSell' | 'openFree' | 'closeFree' | 'openPro' | 'closePro' | 'finalizeEpoch' | 'claim' | 'depositLP' | 'withdrawLP';
export type ErrorCode = 'WRONG_PHASE' | 'ENTRY_PAUSED' | 'DATA_NOT_READY' | 'DATA_STALE' | 'LOW_ACTIVITY' | 'INVALID_DENOMINATOR' | 'PRECISION_UNDERFLOW' | 'VERSION_MISMATCH' | 'REQUOTE_REQUIRED' | 'LIMIT_REACHED' | 'INSUFFICIENT_FREE_CAPITAL' | 'LP_WINDOW_CLOSED' | 'ALREADY_EXECUTED' | 'UNAUTHORIZED' | 'PENDING_CONFIRMATION' | 'BUDGET_EXHAUSTED' | 'STORAGE_BACKLOG' | 'INVALID_INPUT' | 'RPC_RATE_LIMITED';
export interface ApiError { code: ErrorCode; message: string; retryable: boolean; requestId: string | null }
export interface Envelope<T> { schemaVersion: '0.1'; mode: Mode; asOf: UnixSeconds; data: T; nextCursor: string | null }
export interface Observation {
  marketId: string; queryVersion: UInt; queryHash: Hash;
  bucketStart: UnixSeconds; bucketEnd: UnixSeconds;
  value: { kind: 'count'; count: UInt } | { kind: 'missing'; reason: string };
  receivedAt: UnixSeconds; validatedAt: UnixSeconds | null; revision: UInt; rawHash: Hash;
}
export interface SnapshotCandidate extends VersionSet {
  queryHash: Hash;
  admission: TradingAdmission;
  marketId: string; sequence: UInt; dataThrough: UnixSeconds; computedAt: UnixSeconds;
  activityNowQ12: UInt | null; activity7dQ12: UInt | null;
  dataStatus: DataStatus; reason: ErrorCode | null; evidenceHash: Hash;
}
export interface SnapshotRef { marketId: string; sequence: UInt; payloadHash: Hash }
export interface PublishedSnapshot {
  payload: SnapshotCandidate; payloadHash: Hash;
  chain: ChainRef; signature: string; slot: UInt; publishedAt: UnixSeconds;
  finality: 'confirmed' | 'finalized';
  // Only accepted chain snapshots can drive executable quotes.
}
export interface PriceAnchor { graduationPriceAtoms: UInt; graduationNowQ12: UInt; graduation7dQ12: UInt; maxPriceAtoms: UInt }
export interface Capability { allowed: boolean; reason: ErrorCode | null; detail?: 'GLOBAL_OUTSTANDING_LIMIT' | 'GLOBAL_DAILY_LIMIT' | 'FUNDED_PROOF_CAP' }
export interface MarketView {
  /** Operator-declared deterministic QA feed; never measured real-world attention. */
  dataProvenance?: 'SYNTHETIC_QA';
  id: string; keyword: string; aliases: string[]; phase: Phase; dataStatus: DataStatus;
  epochPhase: EpochPhase | null; supported: boolean; chain: ChainRef | null;
  snapshot: PublishedSnapshot | null; anchor: PriceAnchor | null;
  price: { kind: 'curve' | 'indexed'; atoms: UInt; executable: boolean } | null;
  capabilities: Partial<Record<Action, Capability>>;
}
export interface RecordPoint {
  executedAt: UnixSeconds; slot: UInt; signature: string;
  snapshot: SnapshotRef | null;
  h: { numerator: UInt; denominator: UInt } | null;
  unavailableReason: string | null;
}
export type FreeResult = { kind: 'return'; numerator: Int; denominator: UInt } | { kind: 'na'; reason: string };
export interface FreeRecord {
  id: string; wallet: string; marketId: string; direction: 'up';
  entry: RecordPoint; exit: RecordPoint | null;
  status: 'OPEN' | 'CLOSED_RESULT' | 'CLOSED_NA';
  result: FreeResult | null; finality: 'confirmed' | 'finalized'; proofId: string | null;
}
export interface PublicProfile {
  openPreviews?: OpenPreview[]; // Read endpoint supplies these; omit in a pure record projection.
  wallet: string; openRecords: FreeRecord[]; closedRecords: FreeRecord[];
  closedValidCount: UInt; closedNaCount: UInt;
  averageReturn: { numerator: Int; denominator: UInt } | null;
  leaderboardStatus: 'ELIGIBLE' | 'NO_RESULT' | 'HELD_CALCULATION_ERROR';
  // Never add private Pro/LP holdings to this public DTO.
}
export interface Quote extends VersionSet {
  id: string; requestId: string; wallet: string; marketId: string; action: Action; phase: Phase;
  snapshot: SnapshotRef | null; quotedAt: UnixSeconds; expiresAt: UnixSeconds;
  quantityAtoms: UInt | null; collateralAtoms: UInt | null; leverageBps: UInt | null;
  direction: 'long' | 'short' | null; priceAtoms: UInt; maturityAt: UnixSeconds | null;
  grossAtoms: UInt; tradeFeeAtoms: UInt; timePrepaidAtoms: UInt;
  maxPaymentAtoms: UInt; minReceiveAtoms: UInt; maxPayoutAtoms: UInt | null;
  executable: boolean;
}
export interface Claim {
  id: string; owner: string; contractId: string; settlementVersion: UInt;
  payoutAtoms: UInt; refundAtoms: UInt; status: 'UNPAID' | 'PAID';
  priceSnapshot: SnapshotRef; paidSignature: string | null;
}
export interface EvidenceRef { contentHash: Hash; arweaveItemId: string | null; parentTransactionId: string | null }
export interface ProofPayload {
  schemaVersion: '0.1'; record: FreeRecord; versions: VersionSet;
  evidence: EvidenceRef[]; replacesProofId: string | null;
  // Hash this payload; status/retry metadata lives in a separate envelope.
}
export interface ProofStatus {
  id: string; recordId: string; payloadHash: Hash | null;
  manifestRef: EvidenceRef | null;
  state: 'QUEUED' | 'UPLOADED' | 'CONFIRMING' | 'READY_TO_ISSUE' | 'ISSUED' | 'INVALID' | 'REPLACED';
  evidence: EvidenceRef[]; confirmations: number | null; sasId: string | null;
  retryAt: UnixSeconds | null; error: string | null; replacementId: string | null;
}
export interface Operation {
  requestId: string; wallet: string; action: string; signature: string | null;
  state: 'AWAITING_SIGNATURE' | 'SUBMITTED' | 'CONFIRMED' | 'FINALIZED' | 'FAILED' | 'UNKNOWN';
  error: ApiError | null;
}

/** Short-lived wallet authentication; token remains in browser memory only. */
export interface WalletSession {
  token: string; expiresAt: UnixSeconds; wallet: string; cluster: 'localnet' | 'devnet';
}
export interface OperationSubmission { wallet: string; signature: string }

export type LeaderboardPeriod = '7d' | 'all';
export interface LeaderboardEntry {
  rank: number; wallet: string;
  averageReturn: { numerator: Int; denominator: UInt };
  closedValidCount: UInt; closedNaCount: UInt; openCount: UInt;
  status: 'ELIGIBLE'; recordIds: string[];
}
export interface LeaderboardPage {
  period: LeaderboardPeriod; rows: LeaderboardEntry[]; heldWallets: string[];
}
export interface OpenPreview {
  recordId: string; referenceReturn: { numerator: Int; denominator: UInt } | null;
  status: 'REFERENCE' | 'UNAVAILABLE'; observedAt: UnixSeconds | null;
}
/** Data validity and admission are separate: valid recovered data may allow exit first. */
export interface TradingAdmission {
  state: 'BLOCKED' | 'RECOVERING' | 'OPEN';
  recoveryCount: 0 | 1 | 2;
  reason: ErrorCode | null;
}
export interface PollBatch {
  id: string; kind: 'bootstrap' | 'regular' | 'backfill';
  observedAt: UnixSeconds; dataThrough: UnixSeconds;
}
export interface RecoveryState {
  lastPollId: string | null; lastPollAt: UnixSeconds | null;
  dataThrough: UnixSeconds; admission: TradingAdmission;
  outageStartAt: UnixSeconds | null; emergencyAt: UnixSeconds | null;
}
export type ObservationUse = 'initialHistory' | 'first' | 'gapFill' | 'correction';
export interface NotExecutable { kind: 'notExecutable'; reason: string }
export type PreparedTransaction = NotExecutable | {
  kind: 'transaction'; action: Action; requestId: string;
  wallet: string; cluster: 'localnet' | 'devnet'; programId: string;
  expiresAt: UnixSeconds; recordId: string;
  unsignedTransaction: string; lastValidBlockHeight: UInt; quoteRef: string | null;
};
