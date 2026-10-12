import test from 'node:test';
import assert from 'node:assert/strict';
import {admissionBorshBytes, decodeHash, formulaVersionBytes, parseU64} from '../../clients/chain/encoding.mjs';

test('formula version is ASCII in sixteen bytes with only zero padding', () => {
  const got = formulaVersionBytes('h3-d7-q12-v1');
  assert.equal(got.length, 16);
  assert.deepEqual([...got], [...new TextEncoder().encode('h3-d7-q12-v1'), 0, 0, 0, 0]);
  assert.throws(() => formulaVersionBytes('h3-d7-q12-v2'), /VERSION_MISMATCH/);
  assert.throws(() => formulaVersionBytes('h3-d7-q12-v1\0'), /VERSION_MISMATCH/);
});

test('admission state and reason use fixed Borsh tags', () => {
  assert.deepEqual([...admissionBorshBytes({state:'BLOCKED', recoveryCount:0, reason:'DATA_NOT_READY'})], [0, 0, 1, 1]);
  assert.deepEqual([...admissionBorshBytes({state:'RECOVERING', recoveryCount:1, reason:'DATA_NOT_READY'})], [1, 1, 1, 1]);
  assert.deepEqual([...admissionBorshBytes({state:'OPEN', recoveryCount:2, reason:null})], [2, 2, 0]);
  assert.throws(() => admissionBorshBytes({state:'OPEN', recoveryCount:1, reason:null}), /INVALID_INPUT/);
  assert.throws(() => admissionBorshBytes({state:'BLOCKED', recoveryCount:0, reason:'UNRECOGNIZED'}), /INVALID_INPUT/);
});

test('hash and u64 conversion reject noncanonical transport values', () => {
  assert.equal(decodeHash('ab'.repeat(32)).length, 32);
  for (const bad of ['AB'.repeat(32), 'g'.repeat(64), 'a'.repeat(63)]) {
    assert.throws(() => decodeHash(bad), /INVALID_INPUT/);
  }
  assert.equal(parseU64('18446744073709551615'), (1n << 64n) - 1n);
  for (const bad of ['01', '-1', '18446744073709551616', '1.0']) {
    assert.throws(() => parseU64(bad), /INVALID_INPUT/);
  }
});
