import '../../tests/transaction-boundary.test.mjs';
import '../../tests/live-free.test.mjs';
import '../../tests/live-financial.test.mjs';
import './pending-panel.tsx';
import {run} from './test-runtime.mjs';
// These fixtures use only Buffer.from(bytes).toString('base64'). No Node APIs,
// credentials or actual signing implementation are supplied to this page.
globalThis.Buffer={from:bytes=>({toString:encoding=>{
  if(encoding!=='base64')throw Error('Unsupported fixture encoding');
  return btoa(String.fromCharCode(...bytes));
}})};
// Node's check phase follows Response body jobs; allow those browser tasks to
// settle before fixtures deliberately replace an in-flight signer/session.
globalThis.setImmediate=callback=>setTimeout(callback,50);
await run();
