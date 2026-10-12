/** Explicit provider rejection only; timeouts and unknown errors may follow broadcast. */
export function isWalletRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  // Wallet Standard and Phantom's documented user-rejection code.
  return error.code === 4001000 || error.code === 4001;
}

export function walletDisplayError(error: unknown, fallback = 'Could not complete the wallet request.'): string {
  if (isWalletRejection(error)) return 'Cancelled in wallet.';
  const message = error instanceof Error ? error.message : fallback;
  return /[가-힣]/u.test(message) ? fallback : message;
}
