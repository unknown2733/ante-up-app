type Phase = 'quote.start' | 'quote.ready' | 'quote.failed' | 'prepare.start' | 'prepare.ready' | 'verify.start' | 'verify.ready' | 'wallet.start' | 'wallet.response' | 'wallet.failed' | 'execute.failed';
const PREFIX = 'ante-up.financial.';
const retained: string[] = [];
let sequence = 0;

/** Local, bounded timing only. Never store wallet, request, payload, auth or error messages. */
export function startFinancialTiming() {
  const id = ++sequence;
  const started = performance.now();
  return (phase: Phase, remainingSeconds?: number) => {
    try {
      const detail: Record<string, string | number> = { phase, elapsedMs: Math.round(performance.now() - started) };
      if (Number.isFinite(remainingSeconds)) detail.remainingSeconds = Math.floor(remainingSeconds!);
      const name = `${PREFIX}${id}.${phase}`;
      performance.mark(name, { detail }); retained.push(name);
      while (retained.length > 96) performance.clearMarks(retained.shift()!);
    } catch { /* Diagnostics must never change transaction execution or recovery. */ }
  };
}
