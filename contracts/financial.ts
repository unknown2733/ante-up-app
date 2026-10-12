import type { ChainRef, Envelope, EpochPhase, NotExecutable, Phase, SnapshotRef, UInt, UnixSeconds } from './types.ts';

/** Financial execution contract; test assets only. Public profiles remain free-record-only. */
export type FinancialAction = 'faucet' | 'registerMarket' | 'curveBuy' | 'curveSell' | 'graduate' | 'spotBuy' | 'spotSell' | 'openPro' | 'closePro' | 'claim' | 'depositLP' | 'withdrawLP';
export interface FinancialIntent {
  requestId: string; wallet: string; action: FinancialAction;
  marketId: string | null;
  quantityAtoms?: UInt; collateralAtoms?: UInt; leverageBps?: UInt;
  direction?: 'long' | 'short'; positionId?: string; claimId?: string;
  keyword?: string; aliases?: string[];
}
export interface FinancialQuote {
  id: string; intent: FinancialIntent; chain: ChainRef; phase: Phase | null;
  quotedAt: UnixSeconds; expiresAt: UnixSeconds; configVersion: UInt;
  snapshot: SnapshotRef | null; stateVersion: UInt;
  priceAtoms: UInt; grossAtoms: UInt; tradeFeeAtoms: UInt;
  timePrepaidAtoms: UInt; maxPaymentAtoms: UInt; minReceiveAtoms: UInt;
  maxPayoutAtoms: UInt | null; maturityAt: UnixSeconds | null;
  /** This quote does not reserve capital. Recheck all limits during execution. */
  executable: boolean;
}
export type FinancialQuoteResult = NotExecutable | { kind: 'quote'; quote: FinancialQuote };
export interface FinancialPrepareRequest { wallet: string; requestId: string; quoteId: string }
export type FinancialPrepared = NotExecutable | {
  kind: 'transaction'; action: FinancialAction; requestId: string; wallet: string;
  cluster: 'localnet' | 'devnet'; programId: string; expiresAt: UnixSeconds;
  unsignedTransaction: string; lastValidBlockHeight: UInt; quote: FinancialQuote;
};
export interface FinancialPosition {
  id: string; marketId: string; owner: string; direction: 'long' | 'short';
  collateralAtoms: UInt; notionalAtoms: UInt; entryPriceAtoms: UInt;
  maxPayoutAtoms: UInt; openedAt: UnixSeconds; maturityAt: UnixSeconds;
  timePrepaidAtoms: UInt; status: 'OPEN' | 'SETTLED' | 'PAID'; claimId: string | null;
}
export interface FinancialClaim {
  id: string; marketId: string; owner: string; positionId: string;
  payoutAtoms: UInt; refundAtoms: UInt; status: 'UNPAID' | 'PAID';
}
export interface FinancialVault {
  marketId: string; assetsAtoms: UInt; outsideTokensAtoms: UInt;
  spotReserveAtoms: UInt; proReserveAtoms: UInt; otherReserveAtoms: UInt;
  bufferAtoms: UInt; freeCapitalAtoms: string;
  /** Null while N3 valuation conditions are unmet; not a withdrawal quote. */
  navAtoms: UInt | null; totalSharesAtoms: UInt; lockedSharesAtoms: UInt;
  epochPhase: EpochPhase | null;
}
export interface FinancialPortfolio {
  wallet: string; quoteMint: string; quoteBalanceAtoms: UInt;
  tokenBalances: { marketId: string; mint: string; atoms: UInt }[];
  positions: FinancialPosition[]; claims: FinancialClaim[];
  lpShares: { marketId: string; sharesAtoms: UInt; withdrawableAtoms: UInt | null }[];
}
export type FinancialResponse<T> = Envelope<T>;
