import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyKeeperRpcIdentity} from '../src/keeper-rpc-identity.ts';

const genesis='11111111111111111111111111111111';
test('keeper execution binds localnet to loopback and the expected genesis hash',async()=>{
  let reads=0;
  const rpc={getGenesisHash(){return {async send(){reads++;return genesis;}};}};
  await verifyKeeperRpcIdentity({cluster:'localnet',endpoint:'http://127.0.0.1:8899',expectedGenesisHash:genesis,rpc});
  assert.equal(reads,1);
  await assert.rejects(verifyKeeperRpcIdentity({cluster:'localnet',endpoint:'https://rpc.example.org',
    expectedGenesisHash:genesis,rpc}),/KEEPER_LOCALNET_RPC_MUST_BE_LOOPBACK/);
  assert.equal(reads,1);
  await assert.rejects(verifyKeeperRpcIdentity({cluster:'devnet',endpoint:'https://rpc.example.org',
    expectedGenesisHash:'SysvarC1ock11111111111111111111111111111111',rpc}),/KEEPER_GENESIS_MISMATCH/);
  await assert.rejects(verifyKeeperRpcIdentity({cluster:'devnet',endpoint:'https://rpc.example.org',
    expectedGenesisHash:'invalid',rpc}),/KEEPER_EXPECTED_GENESIS_HASH_REQUIRED/);
});
