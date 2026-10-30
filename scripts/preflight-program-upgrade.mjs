/** Read-only Devnet upgrade sizing. Does not load a signer or submit a transaction. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANTE_UP_PROGRAM_ADDRESS } from '../clients/chain/dist/index.js';

const kit = createRequire(new URL('../clients/chain/package.json', import.meta.url))('@solana/kit');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const PROGRAM_DATA_HEADER = 45;
const BUFFER_HEADER = 37;
const check = (condition, code) => { if (!condition) throw new Error(code); };
const amount = value => BigInt(value);
const accountBytes = value => {
  check(value && Array.isArray(value.data) && value.data[1] === 'base64',
    'UPGRADE_ACCOUNT_INVALID');
  return Buffer.from(value.data[0], 'base64');
};

export function inspectUpgradeAccounts(program, programData, expectedAuthority) {
  check(program?.owner === LOADER && program?.executable === true &&
    programData?.owner === LOADER && programData?.executable === false,
  'UPGRADE_LOADER_INVALID');
  const programBytes = accountBytes(program);
  const dataBytes = accountBytes(programData);
  check(programBytes.length === 36 && programBytes.readUInt32LE(0) === 2 &&
    dataBytes.length >= PROGRAM_DATA_HEADER && dataBytes.readUInt32LE(0) === 3,
  'UPGRADE_STATE_INVALID');
  check(dataBytes[12] === 1, 'UPGRADE_AUTHORITY_REVOKED');
  const programDataAddress = kit.getBase58Decoder().decode(programBytes.subarray(4, 36));
  const authority = kit.getBase58Decoder().decode(dataBytes.subarray(13, 45));
  check(authority === expectedAuthority, 'UPGRADE_AUTHORITY_MISMATCH');
  return { programDataAddress, authority, programDataBytes: dataBytes.length,
    programDataLamports: amount(programData.lamports) };
}

export function sizeUpgrade({ sbfBytes, programDataBytes, programDataLamports,
  currentRent, expandedRent, bufferRent, payerLamports, reserveLamports = 100_000_000n,
  headroomBytes = 0 }) {
  check([sbfBytes, programDataBytes, headroomBytes].every(Number.isSafeInteger) &&
    sbfBytes > 0 && programDataBytes >= PROGRAM_DATA_HEADER && headroomBytes >= 0 &&
    [programDataLamports, currentRent, expandedRent, bufferRent, payerLamports,
      reserveLamports].every(value => typeof value === 'bigint' && value >= 0n),
  'UPGRADE_SIZE_INVALID');
  const requiredProgramDataBytes = PROGRAM_DATA_HEADER + sbfBytes + headroomBytes;
  const extensionBytes = Math.max(0, requiredProgramDataBytes - programDataBytes);
  const extensionTopup = expandedRent > programDataLamports ?
    expandedRent - programDataLamports : 0n;
  const peakLamports = bufferRent + extensionTopup + reserveLamports;
  return { sbfBytes, programDataBytes, requiredProgramDataBytes, extensionBytes,
    currentRent: currentRent.toString(), expandedRent: expandedRent.toString(),
    bufferRent: bufferRent.toString(), extensionTopup: extensionTopup.toString(),
    feeReserve: reserveLamports.toString(), peakRequiredLamports: peakLamports.toString(),
    payerLamports: payerLamports.toString(),
    shortfallLamports: (peakLamports > payerLamports ?
      peakLamports - payerLamports : 0n).toString(),
    status: payerLamports >= peakLamports ? 'FUNDED_FOR_ESTIMATE' : 'INSUFFICIENT' };
}

export async function preflightProgramUpgrade({ sbfPath, expectedSha256, rpcFile,
  payer, expectedAuthority = payer, headroomBytes = 0, rpc: injectedRpc }) {
  check(/^[0-9a-f]{64}$/.test(expectedSha256 ?? '') &&
    kit.isAddress(payer) && kit.isAddress(expectedAuthority) &&
    Number.isSafeInteger(headroomBytes) && headroomBytes >= 0,
  'UPGRADE_INPUT_INVALID');
  const sbf = await readFile(sbfPath);
  const sbfSha256 = createHash('sha256').update(sbf).digest('hex');
  check(sbfSha256 === expectedSha256, 'UPGRADE_BINARY_HASH_MISMATCH');
  const endpoint = injectedRpc ? null : (await readFile(rpcFile, 'utf8')).trim();
  check(injectedRpc || /^https:\/\//.test(endpoint), 'DEVNET_RPC_REQUIRED');
  const rpc = injectedRpc ?? kit.createSolanaRpc(endpoint);
  check(await rpc.getGenesisHash().send() === DEVNET_GENESIS, 'DEVNET_GENESIS_MISMATCH');
  const programId = String(ANTE_UP_PROGRAM_ADDRESS);
  const programResponse = await rpc.getAccountInfo(kit.address(programId),
    { commitment: 'finalized', encoding: 'base64' }).send();
  const program = programResponse.value;
  check(program, 'UPGRADE_PROGRAM_MISSING');
  const programBytes = accountBytes(program);
  check(programBytes.length === 36 && programBytes.readUInt32LE(0) === 2,
    'UPGRADE_PROGRAM_INVALID');
  const programDataAddress = kit.getBase58Decoder().decode(programBytes.subarray(4, 36));
  const dataResponse = await rpc.getAccountInfo(kit.address(programDataAddress),
    { commitment: 'finalized', encoding: 'base64' }).send();
  const inspected = inspectUpgradeAccounts(program, dataResponse.value, expectedAuthority);
  check(inspected.programDataAddress === programDataAddress, 'UPGRADE_PROGRAM_DATA_MISMATCH');
  const requiredBytes = PROGRAM_DATA_HEADER + sbf.length + headroomBytes;
  const expandedBytes = Math.max(requiredBytes, inspected.programDataBytes);
  const [payerResponse, currentRent, expandedRent, bufferRent] = await Promise.all([
    rpc.getBalance(kit.address(payer), { commitment: 'finalized' }).send(),
    rpc.getMinimumBalanceForRentExemption(BigInt(inspected.programDataBytes)).send(),
    rpc.getMinimumBalanceForRentExemption(BigInt(expandedBytes)).send(),
    rpc.getMinimumBalanceForRentExemption(BigInt(BUFFER_HEADER + sbf.length)).send()
  ]);
  return { mode: 'READ_ONLY', cluster: 'devnet', programId, programDataAddress,
    authority: inspected.authority, payer, sbfSha256,
    ...sizeUpgrade({ sbfBytes: sbf.length, programDataBytes: inspected.programDataBytes,
      programDataLamports: inspected.programDataLamports, currentRent: amount(currentRent),
      expandedRent: amount(expandedRent), bufferRent: amount(bufferRent),
      payerLamports: amount(payerResponse.value), headroomBytes }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sbfPath, expectedSha256, rpcFile, payer, headroom] = process.argv.slice(2);
  if (!sbfPath || !expectedSha256 || !rpcFile || !payer) {
    console.error('Usage: node scripts/preflight-program-upgrade.mjs SBF TRUSTED_SHA256 RPC_URL_FILE PAYER [HEADROOM_BYTES]');
    process.exitCode = 2;
  } else preflightProgramUpgrade({ sbfPath, expectedSha256, rpcFile, payer,
    headroomBytes: headroom === undefined ? 0 : Number(headroom) })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(String(error?.message ?? error)
        .replace(/https?:\/\/[^\s"'<>]+/g, '[RPC_URL_REDACTED]').slice(0, 160));
      process.exitCode = 1;
    });
}
