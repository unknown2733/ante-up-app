import type { AuthorizationCache } from '@solana-mobile/wallet-standard-mobile';

/** MWA uses the authorization's cached chain when reauthorizing a send. */
export function chainScopedAuthorizationCache(cache: AuthorizationCache, chain: `solana:${string}`): AuthorizationCache {
  return {
    clear: () => cache.clear(),
    async get() {
      const value = await cache.get();
      if (value && value.chain !== chain) { await cache.clear(); return undefined; }
      return value;
    },
    async set(value) {
      if (value.chain !== chain) { await cache.clear(); return; }
      await cache.set(value);
    },
  };
}
