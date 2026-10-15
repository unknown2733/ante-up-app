import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSigner} from '@solana/kit';
import {createVisitorSolRuntime,transferInstruction} from '../src/visitor-sol-runtime.ts';

test('visitor transfer is one bounded System Program transfer with the funder as signer',async()=>{
  const source=await generateKeyPairSigner();
  const target=await generateKeyPairSigner();
  const instruction=transferInstruction(source,String(target.address),5_000_000n);
  assert.equal(instruction.programAddress,'11111111111111111111111111111111');
  assert.deepEqual(instruction.accounts.map(account=>String(account.address)),[String(source.address),String(target.address)]);
  assert.equal(Buffer.from(instruction.data).readUInt32LE(0),2);
  assert.equal(Buffer.from(instruction.data).readBigUInt64LE(4),5_000_000n);
  assert.throws(()=>transferInstruction(source,String(target.address),50_000_001n),/VISITOR_SOL_AMOUNT_INVALID/);
});

test('visitor funder cannot start with an unbounded daily or total cap',async()=>{
  await assert.rejects(createVisitorSolRuntime({endpoint:'https://example.test',dbPath:'unused.sqlite',env:{
    ANTE_UP_VISITOR_SOL_ENABLED:'true',ANTE_UP_VISITOR_SOL_KEYPAIR_FILE:'unused.json',
    ANTE_UP_VISITOR_SOL_GRANT_LAMPORTS:'5000000',ANTE_UP_VISITOR_SOL_DAILY_CAP_LAMPORTS:'500000001',
    ANTE_UP_VISITOR_SOL_TOTAL_CAP_LAMPORTS:'10000000000',
  }}),/VISITOR_SOL_CAP_TOO_HIGH/);
});
