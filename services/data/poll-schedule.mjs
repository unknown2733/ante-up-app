/**
 * Start each paid Counts poll two minutes before the next five-minute
 * boundary. The last settled bucket is already three minutes old then.
 * This leaves time to finalize its snapshot before the previous bucket
 * reaches the protocol's ten-minute stale limit.
 */
export function nextRegularPollAt(lastPollAt) {
  if (!Number.isSafeInteger(lastPollAt) || lastPollAt < 0)
    throw new Error('INVALID_LAST_POLL_TIME');
  const precedingBoundary = Math.floor((lastPollAt + 120) / 300) * 300;
  return precedingBoundary + 180;
}
