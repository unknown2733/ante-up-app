/** Retry only read-only RPC calls rejected by a short-lived provider rate limit. */
export function isRpcRateLimited(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|too many requests|rate limit(?:ed)?/i.test(message);
}

export async function retryRpcRead<T>(read: () => Promise<T>, wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) {
      if (!isRpcRateLimited(error) || attempt >= 2) throw error;
      await wait(500 * 2 ** attempt);
    }
  }
}
