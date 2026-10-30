import assert from 'node:assert/strict';
import test from 'node:test';
import { hideAccountFromReads } from './simulate-retired-snapshot-read.mjs';

test('retirement rehearsal hides only the selected account from finalized RPC reads', async () => {
  const calls = [];
  const rpc = {
    getAccountInfo(address) {
      calls.push(['getAccountInfo', address]);
      return { send: async () => ({ context: { slot: 1n }, value: { owner: 'owner' } }) };
    },
    getProgramAccounts(program) {
      calls.push(['getProgramAccounts', program]);
      return { send: async () => ({ context: { slot: 1n },
        value: [{ pubkey: 'old' }, { pubkey: 'new' }] }) };
    },
    getGenesisHash() { return { send: async () => 'genesis' }; }
  };
  const hidden = hideAccountFromReads(rpc, 'old');
  assert.equal((await hidden.getAccountInfo('old').send()).value, null);
  assert.deepEqual((await hidden.getAccountInfo('new').send()).value, { owner: 'owner' });
  assert.deepEqual((await hidden.getProgramAccounts('program').send()).value,
    [{ pubkey: 'new' }]);
  assert.equal(await hidden.getGenesisHash().send(), 'genesis');
  assert.deepEqual(calls, [['getAccountInfo', 'old'], ['getAccountInfo', 'new'],
    ['getProgramAccounts', 'program']]);
});
