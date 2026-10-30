/** Verify an off-host archive copy and record a short-lived operator receipt. */
import { hostname } from 'node:os';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArchive } from './verify-snapshot-archive.mjs';

export async function createOffhostReceipt({ archivePath, expectedSha256, outPath }) {
  const verified = await verifyArchive({ archivePath, expectedSha256 });
  const receipt = { version: 1, kind: 'SNAPSHOT_OFFHOST_VERIFICATION', host: hostname(),
    archivePath: resolve(archivePath), archiveSha256: verified.fileSha256,
    archiveDigest: verified.digest, snapshots: verified.snapshots,
    verifiedAt: new Date().toISOString() };
  const file = await open(outPath, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archivePath, expectedSha256, outPath] = process.argv.slice(2);
  if (!archivePath || !expectedSha256 || !outPath) {
    console.error('Usage: node scripts/snapshot-offhost-receipt.mjs ARCHIVE_DB TRUSTED_SHA256 OUTPUT_JSON');
    process.exitCode = 2;
  } else createOffhostReceipt({ archivePath, expectedSha256, outPath })
    .then(receipt => console.log(JSON.stringify(receipt)))
    .catch(error => { console.error(String(error?.message ?? error).slice(0, 120)); process.exitCode = 1; });
}
