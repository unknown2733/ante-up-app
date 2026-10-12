import type { PublicProfile } from '../../../contracts/types';

export interface FreeProjectionWait {
  wallet: string;
  cluster: 'devnet' | 'localnet';
  marketId: string;
  action: 'openFree' | 'closeFree';
  recordId: string;
  requestId: string;
  signature: string;
}
type Identity = Pick<FreeProjectionWait, 'wallet' | 'cluster' | 'marketId'>;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const keyOf = (id: Identity) => `ante-up-free-projection:${id.cluster}:${id.wallet}:${id.marketId}`;

/** Chain finality can precede indexed profile visibility. Keep this UX barrier across route/reload. */
export function createFreeProjectionGate(storage?: Store) {
  const memory = new Map<string, FreeProjectionWait>();
  function pending(id: Identity): FreeProjectionWait | null {
    const key = keyOf(id);
    if (memory.has(key)) return memory.get(key)!;
    try {
      const value: unknown = JSON.parse(storage?.getItem(key) ?? 'null');
      if (!value || typeof value !== 'object') return null;
      const marker = value as FreeProjectionWait;
      if (marker.wallet !== id.wallet || marker.cluster !== id.cluster || marker.marketId !== id.marketId ||
        !['openFree', 'closeFree'].includes(marker.action) || ![marker.recordId, marker.requestId, marker.signature].every(value => typeof value === 'string' && value.length > 0)) return null;
      memory.set(key, marker); return marker;
    } catch { return null; }
  }
  function remember(marker: FreeProjectionWait) {
    memory.set(keyOf(marker), marker);
    try { storage?.setItem(keyOf(marker), JSON.stringify(marker)); } catch { /* In-memory barrier survives route changes when storage is unavailable. */ }
  }
  function observe(id: Identity, profile: PublicProfile | null): boolean {
    const marker = pending(id);
    if (!marker || !profile || profile.wallet !== id.wallet) return false;
    const record = [...profile.openRecords, ...profile.closedRecords].find(record => record.id === marker.recordId && record.wallet === id.wallet && record.marketId === id.marketId);
    if (!record || record.finality !== 'finalized' || (marker.action === 'closeFree' && record.status === 'OPEN')) return false;
    // An OPEN that has already been closed elsewhere is also visible; never invent it locally.
    memory.delete(keyOf(id));
    try { storage?.removeItem(keyOf(id)); } catch { /* A storage failure can only retain the conservative barrier on reload. */ }
    return true;
  }
  return { pending, remember, observe };
}
