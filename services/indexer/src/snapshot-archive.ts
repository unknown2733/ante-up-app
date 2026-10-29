import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { verifyArchive } from '../../../scripts/verify-snapshot-archive.mjs';
import type { AccountBytes, ProgramAccountBytes } from './repositories.ts';

/** A previously audited, immutable archive of finalized Snapshot accounts. */
export class TrustedSnapshotArchive {
  private loaded: Promise<Map<string, ProgramAccountBytes>> | null = null;
  private readonly path: string;
  private readonly sha256: string;
  private readonly programId: string;
  constructor(path: string, sha256: string, programId: string) {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('ARCHIVE_TRUSTED_SHA256_REQUIRED');
    this.path=path;this.sha256=sha256;this.programId=programId;
  }
  private async load(): Promise<Map<string, ProgramAccountBytes>> {
    const summary = await verifyArchive({ archivePath: this.path, expectedSha256: this.sha256 });
    if (summary.programId !== this.programId) throw new Error('ARCHIVE_PROGRAM_MISMATCH');
    const db = new DatabaseSync(this.path, { readOnly: true });
    const rows = new Map<string, ProgramAccountBytes>();
    try {
      for (const row of db.prepare('SELECT address,account_data FROM snapshots').all() as Array<{address:string;account_data:Uint8Array}>) {
        if (rows.has(row.address)) throw new Error('ARCHIVE_DUPLICATE_ADDRESS');
        rows.set(row.address, { address: row.address, ownerProgramId: this.programId, data: Buffer.from(row.account_data) });
      }
    } finally { db.close(); }
    // Verify again after the read so a file replaced during loading cannot be trusted.
    const after = createHash('sha256').update(await readFile(this.path)).digest('hex');
    if (after !== this.sha256 || rows.size !== summary.snapshots) throw new Error('ARCHIVE_CHANGED_DURING_READ');
    return rows;
  }
  private entriesMap(): Promise<Map<string, ProgramAccountBytes>> {
    return this.loaded ??= this.load();
  }
  async get(accountAddress: string): Promise<AccountBytes | null> {
    const row = (await this.entriesMap()).get(accountAddress);
    return row ? { ownerProgramId: row.ownerProgramId, data: row.data } : null;
  }
  async entries(): Promise<ProgramAccountBytes[]> {
    return [...(await this.entriesMap()).values()];
  }
}
