import test from 'node:test';
import assert from 'node:assert/strict';
import { startFinancialTiming } from '../src/financialTiming.ts';

const entries = () => performance.getEntriesByType('mark').filter(entry => entry.name.startsWith('ante-up.financial.'));
test('diagnostics retain only bounded timing without any extra caller data', () => {
  const trace = startFinancialTiming();
  const secret = 'never-retain-wallet-auth-payload-or-signature';
  trace('quote.start'); trace('wallet.start', 11.9);
  trace('wallet.failed', -4, new Error(secret, {cause:{code:'ERROR_SESSION_CLOSED', message:secret, wallet:secret, payload:secret}}));
  const marks = entries();
  assert.equal(marks.at(-2).detail.remainingSeconds, 11);
  assert.equal(marks.at(-1).detail.remainingSeconds, -4);
  assert.ok(marks.at(-1).detail.elapsedMs >= marks.at(-2).detail.elapsedMs);
  assert.equal(JSON.stringify(marks).includes(secret), false);
  trace('wallet.failed', 1, {code:secret});
  assert.deepEqual(Object.keys(entries().at(-1).detail).sort(), ['elapsedMs','phase','remainingSeconds']);
  for (let i=0;i<120;i++) startFinancialTiming()('quote.start');
  assert.ok(entries().length <= 96);
});
