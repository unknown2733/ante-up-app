import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { address, createSolanaRpc } from '@solana/kit';
import { retryRpcRead } from './rpc-retry.ts';
import { findSnapshotPda, getMarketDecoder, getSnapshotDecoder, MARKET_DISCRIMINATOR, SNAPSHOT_DISCRIMINATOR } from '../../../clients/chain/dist/index.js';
import type { ProofStatus, SnapshotCandidate } from '../../../contracts/types.ts';
import { canonical, hash as canonicalHash } from '../../data/index.mjs';
import { status as evidenceStatus } from '../../evidence/index.mjs';
import type { ProofResolver, SnapshotResolver } from './generated-decoder.ts';
import { snapshotViewFromGenerated } from './snapshot.ts';
import type { StreamKey } from './sqlite.ts';

const hex = /^[0-9a-f]{64}$/;
export interface AccountBytes {ownerProgramId:string; data:Uint8Array}
export interface FinalizedAccountReader {get(address: string): Promise<AccountBytes | null>}
export interface ProgramAccountBytes extends AccountBytes {address:string}
export interface FinalizedProgramAccountScanner {scan(programId:string):Promise<{slot:string;accounts:ProgramAccountBytes[]}>}

/** Finalized read; callers verify owner, PDA, discriminator and candidate hash. */
export class KitFinalizedAccountReader implements FinalizedAccountReader {
  private readonly rpc: ReturnType<typeof createSolanaRpc>;
  constructor(endpoint: string, rpc?: ReturnType<typeof createSolanaRpc>) {
    if (!/^https?:\/\//.test(endpoint)) throw new Error('RPC_URL_REQUIRED');
    this.rpc = rpc ?? createSolanaRpc(endpoint);
  }
  async get(accountAddress: string): Promise<AccountBytes | null> {
    const response = await retryRpcRead(() => this.rpc.getAccountInfo(address(accountAddress),{commitment:'finalized',encoding:'base64'}).send());
    if (!response.value) return null;
    const data = response.value.data;
    if (!Array.isArray(data) || data[1] !== 'base64' || typeof data[0] !== 'string') throw new Error('INVALID_ACCOUNT_DATA');
    return {ownerProgramId:String(response.value.owner),data:Buffer.from(data[0],'base64')};
  }
  async scan(programId:string):Promise<{slot:string;accounts:ProgramAccountBytes[]}> {
    const response=await retryRpcRead(() => this.rpc.getProgramAccounts(address(programId),{commitment:'finalized',encoding:'base64',withContext:true}).send());
    const accounts:ProgramAccountBytes[]=response.value.map(row=>{
      const data=row.account.data;
      if (!Array.isArray(data) || data[1]!=='base64' || typeof data[0]!=='string') throw new Error('INVALID_ACCOUNT_DATA');
      return {address:String(row.pubkey),ownerProgramId:String(row.account.owner),data:Buffer.from(data[0],'base64')};
    });
    // Some Devnet RPC account indexes omit older Snapshot PDAs while reporting a
    // newer finalized context slot. The immutable market sequence lets us
    // detect those holes and verify each missing PDA with a direct account read.
    const markets=new Map<string,bigint>(),snapshots=new Map<string,Set<string>>();
    for(const account of accounts){
      if(account.ownerProgramId!==programId)throw new Error('PROGRAM_SCAN_OWNER_MISMATCH');
      if(Buffer.from(account.data.subarray(0,8)).equals(Buffer.from(MARKET_DISCRIMINATOR))){
        const market=getMarketDecoder().decode(account.data);
        if(markets.has(account.address))throw new Error('PROGRAM_SCAN_DUPLICATE_MARKET');
        markets.set(account.address,market.latestSequence);
      }else if(Buffer.from(account.data.subarray(0,8)).equals(Buffer.from(SNAPSHOT_DISCRIMINATOR))){
        const snapshot=getSnapshotDecoder().decode(account.data);
        const key=String(snapshot.market),seen=snapshots.get(key)??new Set<string>(),sequence=snapshot.sequence.toString();
        if(seen.has(sequence))throw new Error('PROGRAM_SCAN_DUPLICATE_SNAPSHOT');
        seen.add(sequence);snapshots.set(key,seen);
      }
    }
    let repaired=0;
    for(const [market,latest] of markets){
      if(latest>1_000_000n)throw new Error('PROGRAM_SCAN_SEQUENCE_INVALID');
      const seen=snapshots.get(market)??new Set<string>();
      for(let sequence=1n;sequence<=latest;sequence++){
        if(seen.has(sequence.toString()))continue;
        if(++repaired>32)throw new Error('PROGRAM_SCAN_INCOMPLETE');
        const [snapshotAddress]=await findSnapshotPda({market:address(market),sequence},{programAddress:address(programId)});
        const found=await this.get(String(snapshotAddress));
        if(!found||found.ownerProgramId!==programId||
          !Buffer.from(found.data.subarray(0,8)).equals(Buffer.from(SNAPSHOT_DISCRIMINATOR)))
          throw new Error('PROGRAM_SCAN_INCOMPLETE');
        const snapshot=getSnapshotDecoder().decode(found.data);
        if(String(snapshot.market)!==market||snapshot.sequence!==sequence)throw new Error('PROGRAM_SCAN_INCOMPLETE');
        accounts.push({address:String(snapshotAddress),...found});
        seen.add(sequence.toString());
      }
      if(BigInt(seen.size)!==latest)throw new Error('PROGRAM_SCAN_INCOMPLETE');
    }
    for(const [market,seen] of snapshots){
      const latest=markets.get(market);
      if(latest===undefined||BigInt(seen.size)>latest||[...seen].some(sequence=>BigInt(sequence)>latest))
        throw new Error('PROGRAM_SCAN_INCOMPLETE');
    }
    return {slot:response.context.slot.toString(),accounts};
  }
}

/** Immutable local handoff from C/E workers to a finalized event decoder. */
export class SqliteEventRepositories implements SnapshotResolver, ProofResolver {
  private readonly db: DatabaseSync;
  private readonly accounts: FinalizedAccountReader;
  constructor(path: string, accounts: FinalizedAccountReader) {
    this.accounts=accounts;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS snapshot_candidates(cluster TEXT NOT NULL,program_id TEXT NOT NULL,market_address TEXT NOT NULL,sequence TEXT NOT NULL,payload_hash TEXT NOT NULL,candidate_json TEXT NOT NULL,PRIMARY KEY(cluster,program_id,market_address,sequence),UNIQUE(cluster,program_id,payload_hash));
      CREATE TABLE IF NOT EXISTS proof_id_links(cluster TEXT NOT NULL,program_id TEXT NOT NULL,record_address TEXT NOT NULL,proof_hash TEXT NOT NULL,proof_id TEXT NOT NULL,proof_json TEXT NOT NULL,PRIMARY KEY(cluster,program_id,record_address,proof_hash));`);
  }
  close() {this.db.close();}
  /** Accept C's published snapshots or queued publication jobs; account verification follows at event time. */
  async importCandidateFile(path: string, scope: StreamKey): Promise<number> {
    const data = JSON.parse(await readFile(path,'utf8')) as {jobs?:Record<string,unknown>;snapshots?:Record<string,unknown>};
    let imported = 0;
    for (const value of [...Object.values(data.snapshots ?? {}),...Object.values(data.jobs ?? {})]) {
      const item = value as {market?:{address?:string;cluster?:string;programId?:string};candidate?:SnapshotCandidate;candidateHash?:string};
      if (!item.market?.address || item.market.cluster !== scope.cluster || item.market.programId !== scope.programId || !item.candidate) continue;
      const hash = canonicalHash(item.candidate);
      if (hash !== item.candidateHash) throw new Error('CANDIDATE_HASH_MISMATCH');
      this.putCandidate(scope,item.market.address,item.candidate);
      imported++;
    }
    return imported;
  }
  async importProofFile(path: string, scope: StreamKey): Promise<number> {
    const jobs = JSON.parse(await readFile(path,'utf8')) as Record<string,unknown>;
    let imported = 0;
    for (const value of Object.values(jobs)) {
      const job = value as {recordId?:string;payloadHash?:string|null};
      if (!job.recordId || !job.payloadHash) continue;
      this.putProof(scope,job.recordId,evidenceStatus(job) as ProofStatus);
      imported++;
    }
    return imported;
  }
  putCandidate(scope: StreamKey, marketAddress: string, candidate: SnapshotCandidate): string {
    const payloadHash = canonicalHash(candidate);
    if (candidate.marketId !== marketAddress || !hex.test(payloadHash)) throw new Error('CANDIDATE_MARKET_MISMATCH');
    const json = canonical(candidate);
    this.db.prepare('INSERT OR IGNORE INTO snapshot_candidates VALUES(?,?,?,?,?,?)').run(scope.cluster,scope.programId,marketAddress,candidate.sequence,payloadHash,json);
    const row = this.db.prepare('SELECT payload_hash,candidate_json FROM snapshot_candidates WHERE cluster=? AND program_id=? AND market_address=? AND sequence=?').get(scope.cluster,scope.programId,marketAddress,candidate.sequence) as {payload_hash:string;candidate_json:string};
    if (row.payload_hash !== payloadHash || row.candidate_json !== json) throw new Error('CANDIDATE_CONFLICT');
    return payloadHash;
  }
  putProof(scope: StreamKey, recordAddress: string, proof: ProofStatus): void {
    if (!proof.payloadHash || !hex.test(proof.payloadHash) || proof.recordId !== recordAddress || !proof.id) throw new Error('PROOF_LINK_INVALID');
    const json = JSON.stringify(proof);
    this.db.prepare('INSERT OR IGNORE INTO proof_id_links VALUES(?,?,?,?,?,?)').run(scope.cluster,scope.programId,recordAddress,proof.payloadHash,proof.id,json);
    const row = this.db.prepare('SELECT proof_id,proof_json FROM proof_id_links WHERE cluster=? AND program_id=? AND record_address=? AND proof_hash=?').get(scope.cluster,scope.programId,recordAddress,proof.payloadHash) as {proof_id:string;proof_json:string};
    if (row.proof_id !== proof.id) throw new Error('PROOF_LINK_CONFLICT');
    if (row.proof_json !== json) this.db.prepare('UPDATE proof_id_links SET proof_json=? WHERE cluster=? AND program_id=? AND record_address=? AND proof_hash=?').run(json,scope.cluster,scope.programId,recordAddress,proof.payloadHash);
  }
  proofs(cluster: StreamKey['cluster'], programId: string): ProofStatus[] {
    return (this.db.prepare('SELECT proof_json FROM proof_id_links WHERE cluster=? AND program_id=?').all(cluster,programId) as Array<{proof_json:string}>).map(row=>JSON.parse(row.proof_json) as ProofStatus);
  }
  async resolve(input: {marketAddress:string;sequence:string;payloadHash:string;scope:StreamKey}): Promise<{marketId:string;candidate:SnapshotCandidate;account:ReturnType<typeof snapshotViewFromGenerated>}>;
  async resolve(input: {recordAddress:string;proofHash:string;scope:StreamKey}): Promise<string>;
  async resolve(input: {marketAddress?:string;sequence?:string;payloadHash?:string;recordAddress?:string;proofHash?:string;scope:StreamKey}) {
    if (input.recordAddress !== undefined) {
      const row = this.db.prepare('SELECT proof_id FROM proof_id_links WHERE cluster=? AND program_id=? AND record_address=? AND proof_hash=?').get(input.scope.cluster,input.scope.programId,input.recordAddress,input.proofHash!) as {proof_id:string}|undefined;
      if (!row) throw new Error('PROOF_ID_UNRESOLVED');
      return row.proof_id;
    }
    const marketAddress = input.marketAddress!, sequence = input.sequence!, payloadHash = input.payloadHash!;
    const row = this.db.prepare('SELECT candidate_json FROM snapshot_candidates WHERE cluster=? AND program_id=? AND market_address=? AND sequence=? AND payload_hash=?').get(input.scope.cluster,input.scope.programId,marketAddress,sequence,payloadHash) as {candidate_json:string}|undefined;
    if (!row) throw new Error('CANDIDATE_UNAVAILABLE');
    const candidate = JSON.parse(row.candidate_json) as SnapshotCandidate;
    if (canonicalHash(candidate) !== payloadHash || candidate.marketId !== marketAddress) throw new Error('CANDIDATE_HASH_MISMATCH');
    const [snapshotAddress] = await findSnapshotPda({market:address(marketAddress),sequence:BigInt(sequence)},{programAddress:address(input.scope.programId)});
    const account = await this.accounts.get(String(snapshotAddress));
    if (!account || account.ownerProgramId !== input.scope.programId || !Buffer.from(account.data.subarray(0,8)).equals(Buffer.from(SNAPSHOT_DISCRIMINATOR))) throw new Error('SNAPSHOT_ACCOUNT_UNAVAILABLE');
    const view = snapshotViewFromGenerated(getSnapshotDecoder().decode(account.data),String(snapshotAddress),account.ownerProgramId);
    return {marketId:marketAddress,candidate,account:view};
  }
}
