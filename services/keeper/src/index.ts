export interface KeeperTarget {
  marketId: string;
  epochId: string;
  maturityAt: number;
  state: 'PRO_OPEN' | 'OPEN_CUTOFF' | 'SETTLING' | 'LP_WINDOW';
  /** Finalized on-chain common price input fixed for this epoch, never a live quote. */
  settlementInput: {
    candidateHash: string; priceAtoms: string; dataThrough: number; finalized: true;
    mode: 'NORMAL' | 'RECOVERY' | 'EMERGENCY'; maturityAt: number; eligibleAt: number; effectiveCloseAt: number;
    /** Required for RECOVERY and EMERGENCY; verified by B's common settlement account reader. */
    outageStartedAt: number | null;
  } | null;
}

export interface KeeperAdapter {
  readTarget(marketId: string, epochId: string): Promise<KeeperTarget>;
  findExistingExecution(marketId: string, epochId: string): Promise<string | null>;
  hasUnresolvedAttempt(marketId: string, epochId: string): Promise<boolean>;
  markUnknown(marketId: string, epochId: string): Promise<void>;
  submitFinalize(target: KeeperTarget): Promise<string>;
}

/** Calls B's eventual finalize instruction; no payout, maturity price, or claim math is duplicated here. */
export async function finalizeDueEpoch(adapter: KeeperAdapter, marketId: string, epochId: string, now: number): Promise<{ state: 'notDue' | 'existing' | 'submitted' | 'unknown'; signature: string | null }> {
  const target = await adapter.readTarget(marketId, epochId);
  if (target.marketId !== marketId || target.epochId !== epochId || !Number.isSafeInteger(target.maturityAt)) throw new Error('KEEPER_TARGET_MISMATCH');
  if (target.state !== 'SETTLING' || !target.settlementInput) return { state: 'notDue', signature: null };
  const input = target.settlementInput;
  if (!/^[0-9a-f]{64}$/.test(input.candidateHash) || !/^(0|[1-9][0-9]*)$/.test(input.priceAtoms) ||
      !Number.isSafeInteger(input.dataThrough) || input.dataThrough<0 || !Number.isSafeInteger(input.eligibleAt) ||
      !Number.isSafeInteger(input.effectiveCloseAt) || input.dataThrough>input.effectiveCloseAt ||
      input.maturityAt!==target.maturityAt || input.finalized !== true ||
      !['NORMAL','RECOVERY','EMERGENCY'].includes(input.mode)) throw new Error('KEEPER_SETTLEMENT_INPUT_INVALID');
  if (input.mode === 'EMERGENCY') {
    if (!Number.isSafeInteger(input.outageStartedAt) || input.outageStartedAt! < 0 ||
        input.dataThrough > input.outageStartedAt! || input.eligibleAt < input.outageStartedAt! + 86_400 ||
        input.effectiveCloseAt!==Math.min(target.maturityAt,input.eligibleAt)) throw new Error('KEEPER_SETTLEMENT_INPUT_INVALID');
  } else if (input.dataThrough > target.maturityAt || input.eligibleAt < target.maturityAt + 900 || input.effectiveCloseAt!==target.maturityAt ||
      (input.mode==='NORMAL' && input.outageStartedAt!==null) ||
      (input.mode==='RECOVERY' && (!Number.isSafeInteger(input.outageStartedAt) || input.outageStartedAt!<0 || input.outageStartedAt!>=input.eligibleAt))) throw new Error('KEEPER_SETTLEMENT_INPUT_INVALID');
  if (now < input.eligibleAt) return { state: 'notDue', signature: null };
  const existing = await adapter.findExistingExecution(marketId, epochId);
  if (existing) return { state: 'existing', signature: existing };
  if (await adapter.hasUnresolvedAttempt(marketId, epochId)) return { state: 'unknown', signature: null };
  try {
    const signature = await adapter.submitFinalize(target);
    return { state: 'submitted', signature };
  } catch {
    await adapter.markUnknown(marketId, epochId);
    return { state: 'unknown', signature: null };
  }
}

export interface LpWindowTarget {
  marketId: string;
  epochId: string;
  state: 'INITIAL_LP' | 'PRO_OPEN' | 'OPEN_CUTOFF' | 'SETTLING' | 'LP_WINDOW';
  allPayoutsFixed: boolean;
  /** Null after an outage or invalid NAV; recovery starts a fresh 900-second interval. */
  validNavSince: number | null;
  navCurrentlyValid: boolean;
}
export interface LpWindowAdapter {
  readWindowTarget(marketId: string, epochId: string): Promise<LpWindowTarget>;
  findExistingWindow(marketId: string, epochId: string): Promise<string | null>;
  hasUnresolvedWindowAttempt(marketId: string, epochId: string): Promise<boolean>;
  markWindowUnknown(marketId: string, epochId: string): Promise<void>;
  submitOpenWindow(target: LpWindowTarget): Promise<string>;
  findExistingResume(marketId: string, epochId: string): Promise<string | null>;
  hasUnresolvedResumeAttempt(marketId: string, epochId: string): Promise<boolean>;
  markResumeUnknown(marketId: string, epochId: string): Promise<void>;
  submitResumePro(target: LpWindowTarget): Promise<string>;
}

/** Unpaid Claim balances are not a blocker here; their fixed debt remains in NAV. */
export async function openLpWindowWhenReady(adapter: LpWindowAdapter, marketId: string, epochId: string, now: number): Promise<{state:'notDue'|'existing'|'submitted'|'unknown';signature:string|null}> {
  const target=await adapter.readWindowTarget(marketId,epochId);
  if (target.marketId!==marketId || target.epochId!==epochId) throw new Error('KEEPER_TARGET_MISMATCH');
  if (target.state==='LP_WINDOW') {
    const signature=await adapter.findExistingWindow(marketId,epochId);
    return {state:'existing',signature};
  }
  if (target.state!=='SETTLING' || !target.allPayoutsFixed || !target.navCurrentlyValid ||
      target.validNavSince===null || !Number.isSafeInteger(target.validNavSince) || target.validNavSince>now) return {state:'notDue',signature:null};
  const existing=await adapter.findExistingWindow(marketId,epochId);
  if (existing) return {state:'existing',signature:existing};
  if (await adapter.hasUnresolvedWindowAttempt(marketId,epochId)) return {state:'unknown',signature:null};
  try { return {state:'submitted',signature:await adapter.submitOpenWindow(target)}; }
  catch { await adapter.markWindowUnknown(marketId,epochId); return {state:'unknown',signature:null}; }
}

/** The next Pro cycle opens only after LP has had 900 uninterrupted valid NAV seconds. */
export async function resumeProAfterLpWindow(adapter: LpWindowAdapter, marketId: string, epochId: string, now: number): Promise<{state:'notDue'|'existing'|'submitted'|'unknown';signature:string|null}> {
  const target=await adapter.readWindowTarget(marketId,epochId);
  if (target.marketId!==marketId || target.epochId!==epochId) throw new Error('KEEPER_TARGET_MISMATCH');
  if (target.state==='PRO_OPEN') return {state:'existing',signature:await adapter.findExistingResume(marketId,epochId)};
  if (target.state!=='LP_WINDOW' || !target.allPayoutsFixed || !target.navCurrentlyValid ||
      target.validNavSince===null || !Number.isSafeInteger(target.validNavSince) || target.validNavSince>now-900) return {state:'notDue',signature:null};
  const existing=await adapter.findExistingResume(marketId,epochId);
  if (existing) return {state:'existing',signature:existing};
  if (await adapter.hasUnresolvedResumeAttempt(marketId,epochId)) return {state:'unknown',signature:null};
  try { return {state:'submitted',signature:await adapter.submitResumePro(target)}; }
  catch { await adapter.markResumeUnknown(marketId,epochId); return {state:'unknown',signature:null}; }
}
