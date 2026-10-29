/**
 * Start each paid Counts poll two minutes before the next five-minute
 * boundary. The last settled bucket is already three minutes old then.
 * This leaves time to finalize its snapshot before the previous bucket
 * reaches the protocol's ten-minute stale limit. On the first shift,
 * skip a bucket rather than violating the paid source's 300-second
 * minimum interval. Once aligned, keep the actual 300-second cadence;
 * real polls can land a second after the nominal target.
 */
export function nextRegularPollAt(lastPollAt) {
  if (!Number.isSafeInteger(lastPollAt) || lastPollAt < 0)
    throw new Error('INVALID_LAST_POLL_TIME');
  const earliest = lastPollAt + 300;
  if (!Number.isSafeInteger(earliest)) throw new Error('INVALID_LAST_POLL_TIME');
  const phase = lastPollAt % 300;
  if (phase >= 180 && phase < 270) return earliest;
  return Math.ceil((earliest - 180) / 300) * 300 + 180;
}
