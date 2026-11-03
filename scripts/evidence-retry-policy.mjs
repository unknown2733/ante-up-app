export const TURBO_READ_EXIT_CODE = 75;

const TURBO_READ_CODES = new Set([
  'TURBO_BALANCE_UNAVAILABLE',
  'TURBO_FREE_STATUS_UNAVAILABLE',
  'TURBO_COST_QUOTE_UNAVAILABLE',
  // Read-only archive checks; the job's own backoff still applies. These must
  // not impose an additional one-hour worker delay on its 5/15-minute retry.
  'PARENT_METADATA_TIMEOUT',
  'PARENT_METADATA_UNAVAILABLE',
  'PARENT_BUNDLE_FETCH_TIMEOUT',
  'PARENT_BUNDLE_FETCH_UNAVAILABLE',
  'PARENT_STATUS_TIMEOUT',
  'PARENT_STATUS_UNAVAILABLE',
]);

export function isTransientTurboRead(error) {
  return TURBO_READ_CODES.has(error?.message);
}

export function evidenceRetryDelaySeconds(exitCode,{completionPending=false}={}) {
  if(exitCode===0 && completionPending)return 60;
  return exitCode === 0 || exitCode === TURBO_READ_EXIT_CODE ? 300 : 3600;
}
