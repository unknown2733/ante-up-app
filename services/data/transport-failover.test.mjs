import test from 'node:test';
import assert from 'node:assert/strict';
import { withChainReadFailover } from './transport-failover.mjs';

function transport(read, send) {
  return Object.fromEntries([...['getFinalizedAccount', 'getLatestBlockhash', 'isBlockhashValid',
    'getSignatureStatus', 'getBlockHeight'].map(method => [method, read]), ['sendTransaction', send]]);
}

test('collector reads switch for a bounded interval; broadcast remains primary only', async () => {
  let time = 1000, primaryReads = 0, backupReads = 0, primarySends = 0, backupSends = 0, validation = 0;
  const primary = transport(async () => {
    primaryReads++;
    if (primaryReads === 1) throw Error('HTTP 429');
    return 'primary';
  }, async () => {primarySends++; return 'primary-signature';});
  const backup = transport(async () => {backupReads++; return 'backup';},
    async () => {backupSends++; return 'backup-signature';});
  const chain = withChainReadFailover(primary,backup,{now:()=>time,cooldownMs:60_000,
    validateBackup:async()=>{validation++;}});
  assert.equal(await chain.getFinalizedAccount('market'), 'backup');
  assert.equal(await chain.getBlockHeight(), 'backup');
  assert.equal(await chain.sendTransaction('wire'), 'primary-signature');
  assert.deepEqual([primaryReads,backupReads,validation,primarySends,backupSends],[1,2,1,1,0]);
  time += 60_000;
  assert.equal(await chain.getBlockHeight(), 'primary');
});

test('collector does not switch for data errors or an unvalidated backup', async () => {
  let backupReads = 0;
  const primary = transport(async () => {throw Error('INVALID_ACCOUNT_DATA');}, async () => 'signed');
  const backup = transport(async () => {backupReads++; return 'backup';}, async () => 'backup');
  const chain = withChainReadFailover(primary,backup);
  await assert.rejects(() => chain.getFinalizedAccount('market'), /INVALID_ACCOUNT_DATA/);
  assert.equal(backupReads,0);
  const limited = withChainReadFailover(transport(async()=>{throw Error('HTTP 429');},async()=> 'signed'),
    backup,{validateBackup:async()=>{throw Error('RPC_FAILOVER_GENESIS_MISMATCH');}});
  await assert.rejects(() => limited.getLatestBlockhash(),/RPC_FAILOVER_GENESIS_MISMATCH/);
  assert.equal(backupReads,0);
});
