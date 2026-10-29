export const TURBO_READ_EXIT_CODE = 75;

const TURBO_READ_CODES = new Set([
  'TURBO_BALANCE_UNAVAILABLE',
  'TURBO_FREE_STATUS_UNAVAILABLE',
  'TURBO_COST_QUOTE_UNAVAILABLE',
]);

export function isTransientTurboRead(error) {
  return TURBO_READ_CODES.has(error?.message);
}

export function evidenceRetryDelaySeconds(exitCode) {
  return exitCode === 0 || exitCode === TURBO_READ_EXIT_CODE ? 300 : 3600;
}
