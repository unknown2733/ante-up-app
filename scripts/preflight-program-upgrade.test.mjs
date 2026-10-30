import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { inspectUpgradeAccounts, sizeUpgrade } from './preflight-program-upgrade.mjs';

const kit = createRequire(new URL('../clients/chain/package.json', import.meta.url))('@solana/kit');
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const authority = '5Fm81PP7TXvyNJHoB4DrwWETYdfqKtc45s6WRK8qdx5e';
const programDataAddress = '11111111111111111111111111111111';
const encoded = bytes => [Buffer.from(bytes).toString('base64'), 'base64'];

test('upgrade inspection binds the program data account and upgrade authority', () => {
  const programBytes = Buffer.alloc(36);
  programBytes.writeUInt32LE(2, 0);
  programBytes.set(kit.getBase58Encoder().encode(programDataAddress), 4);
  const dataBytes = Buffer.alloc(100);
  dataBytes.writeUInt32LE(3, 0);
  dataBytes[12] = 1;
  dataBytes.set(kit.getBase58Encoder().encode(authority), 13);
  const program = { owner: LOADER, executable: true, data: encoded(programBytes) };
  const programData = { owner: LOADER, executable: false,
    data: encoded(dataBytes), lamports: 9_000n };
  assert.deepEqual(inspectUpgradeAccounts(program, programData, authority), {
    programDataAddress, authority, programDataBytes: 100, programDataLamports: 9_000n
  });
  assert.throws(() => inspectUpgradeAccounts(program, programData, programDataAddress),
    /UPGRADE_AUTHORITY_MISMATCH/);
  dataBytes[12] = 0;
  assert.throws(() => inspectUpgradeAccounts(program, { ...programData,
    data: encoded(dataBytes) }, authority), /UPGRADE_AUTHORITY_REVOKED/);
});

test('upgrade sizing reports peak buffer plus extension funding and a reserve', () => {
  const result = sizeUpgrade({ sbfBytes: 100, programDataBytes: 120,
    programDataLamports: 1_000n, currentRent: 1_000n, expandedRent: 1_200n,
    bufferRent: 700n, payerLamports: 950n, reserveLamports: 100n });
  assert.equal(result.extensionBytes, 25);
  assert.equal(result.extensionTopup, '200');
  assert.equal(result.peakRequiredLamports, '1000');
  assert.equal(result.shortfallLamports, '50');
  assert.equal(result.status, 'INSUFFICIENT');
  const enough = sizeUpgrade({ sbfBytes: 100, programDataBytes: 150,
    programDataLamports: 1_200n, currentRent: 1_000n, expandedRent: 1_000n,
    bufferRent: 700n, payerLamports: 950n, reserveLamports: 100n });
  assert.equal(enough.extensionBytes, 0);
  assert.equal(enough.status, 'FUNDED_FOR_ESTIMATE');
});
