import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReferenceObservationStore } from './reference-observations.ts';
import { validateReferenceObservation } from '../../../contracts/reference/observations.ts';

/** Operator import boundary. Source-specific collectors must extract counts before this step. */
export async function ingestReferenceEvidence(args: { dbPath: string; observationPath: string; rawPath: string }) {
  const [observationBytes, rawBytes] = await Promise.all([
    readFile(resolve(args.observationPath)), readFile(resolve(args.rawPath)),
  ]);
  if (observationBytes.byteLength > 16_384 || rawBytes.byteLength > 2_000_000)
    throw new Error('REFERENCE_EVIDENCE_TOO_LARGE');
  const observation = validateReferenceObservation(JSON.parse(observationBytes.toString('utf8')));
  const actualHash = createHash('sha256').update(rawBytes).digest('hex');
  if (actualHash !== observation.rawSha256) throw new Error('REFERENCE_RAW_HASH_MISMATCH');
  const store = new ReferenceObservationStore(resolve(args.dbPath));
  try { return { inserted: store.append(observation, rawBytes), slug: observation.slug, observedAtMs: observation.observedAtMs }; }
  finally { store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dbPath, observationPath, rawPath] = process.argv.slice(2);
  if (!dbPath || !observationPath || !rawPath) throw new Error('Usage: node reference-ingest.ts <db.sqlite> <observation.json> <raw-response-file>');
  console.log(JSON.stringify(await ingestReferenceEvidence({ dbPath, observationPath, rawPath })));
}
