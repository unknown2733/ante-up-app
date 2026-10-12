/** API time anchors deadlines; device wall-clock skew must not reject fresh challenges. */
export function createApiClock(monotonic = () => performance.now(), wall = () => Date.now()) {
  let anchor: {seconds:number; tick:number} | null = null;
  const estimate = () => anchor ? anchor.seconds + Math.max(0,monotonic()-anchor.tick)/1000 : wall()/1000;
  return {
    nowSeconds: () => Math.floor(estimate()),
    observe(asOf:number, requestStarted:number) {
      if (!Number.isSafeInteger(asOf) || asOf<=0 || !Number.isFinite(requestStarted)) throw new Error('Invalid API clock.');
      const tick=monotonic();
      // Count the full request duration conservatively, never extend a deadline by RTT.
      const seconds=asOf+Math.max(0,tick-requestStarted)/1000;
      anchor={seconds:anchor?Math.max(estimate(),seconds):seconds,tick};
    },
  };
}
