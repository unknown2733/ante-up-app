import { canonical, payloadHash, sha256 } from './index.mjs';
import { replay, hash as candidateHash } from '../data/index.mjs';
import { sourceInvalidOutageCandidate } from '../data/publisher.mjs';

const check = (ok,code='INVALID_EVIDENCE') => { if (!ok) throw new Error(code); };

// These are the archived artifact bytes referenced by ProofPayload.evidence.
export const calculationArtifact = (recordId,points) =>
  canonical({kind:'calculation',schemaVersion:'0.1',recordId,points});
export const rawCountsArtifact = raw =>
  canonical({kind:'x-counts-raw',schemaVersion:'0.1',rawHash:candidateHash(raw),raw});
export const marketVersionArtifact = version =>
  canonical({kind:'market-version',schemaVersion:'0.1',...version});

// packet is obtained from finalized chain indexing and retained observations,
// never from user-supplied text alone. chainVerifier authenticates those reads.
export async function verifySemanticPacket(payload,packet,chainVerifier,storage) {
  check(typeof chainVerifier === 'function' && typeof storage?.fetch === 'function' && packet?.record && packet.points);
  check(canonical(packet.record)===canonical(payload.record));
  check(payload.record.finality==='finalized' && ['CLOSED_RESULT','CLOSED_NA'].includes(payload.record.status));
  check(await chainVerifier(packet.record,packet.points,packet.marketVersion??null)===true,'CHAIN_NOT_VERIFIED');
  // Archived evidence is a canonical JSON envelope. The manifest's refs must
  // lead to these exact bytes, rather than to unrelated uploaded text.
  check(Array.isArray(payload.evidence) && payload.evidence.length>0);
  const artifacts=[];
  const seenRefs=new Set();
  for (const ref of payload.evidence) {
    check(ref && /^[a-f0-9]{64}$/.test(ref.contentHash) && typeof ref.arweaveItemId==='string' &&
      ref.arweaveItemId.length>0 && typeof ref.parentTransactionId==='string' && ref.parentTransactionId.length>0);
    check(!seenRefs.has(ref.arweaveItemId)); seenRefs.add(ref.arweaveItemId);
    const bytes=await storage.fetch(ref);
    check(typeof bytes==='string' && sha256(Buffer.from(bytes,'utf8'))===ref.contentHash,'CONTENT_MISMATCH');
    let artifact;
    try { artifact=JSON.parse(bytes); } catch { throw new Error('INVALID_EVIDENCE'); }
    check(canonical(artifact)===bytes);
    artifacts.push(artifact);
  }
  const calculation=artifacts.filter(a=>a?.kind==='calculation');
  check(calculation.length===1 && canonical(calculation[0])===
    calculationArtifact(payload.record.id,packet.points));
  const rawHashes=new Set();
  if (['entry','exit'].every(name=>payload.record[name]?.snapshot===null)) {
    const version=artifacts.filter(a=>a?.kind==='market-version');
    check(packet.marketVersion && version.length===1 &&
      canonical(version[0])===marketVersionArtifact(packet.marketVersion) &&
      packet.marketVersion.marketId===payload.record.marketId &&
      packet.marketVersion.source==='finalized-program-accounts' &&
      ['schemaVersion','formulaVersion','configVersion','queryVersion'].every(k=>
        packet.marketVersion[k]===payload.versions[k]),'MARKET_VERSION_EVIDENCE_MISSING');
  }
  for (const artifact of artifacts.filter(a=>a?.kind==='x-counts-raw')) {
    check(artifact.schemaVersion==='0.1' && artifact.raw && typeof artifact.raw==='object');
    const rawHash=candidateHash(artifact.raw);
    check(canonical(artifact)===rawCountsArtifact(artifact.raw) &&
      artifact.rawHash===rawHash && !rawHashes.has(rawHash));
    rawHashes.add(rawHash);
  }
  for (const name of ['entry','exit']) {
    const point=payload.record[name], evidence=packet.points[name];
    check(point && evidence);
    if (point.snapshot===null) {
      check(point.h===null && typeof point.unavailableReason==='string' && point.unavailableReason.length>0);
      check(evidence.published===null && evidence.replayInput===null);
      continue;
    }
    const published=evidence.published;
    check(published?.finality==='finalized' && published.payload?.marketId===payload.record.marketId);
    check(published.payload.formulaVersion==='h3-d7-q12-v1' && /^[a-f0-9]{64}$/.test(published.payload.queryHash));
    check(point.snapshot.marketId===published.payload.marketId && point.snapshot.sequence===published.payload.sequence);
    check(published.payloadHash===candidateHash(published.payload) && point.snapshot.payloadHash===published.payloadHash);
    check(evidence.replayInput && evidence.replayInput.queryHash===published.payload.queryHash &&
      evidence.replayInput.queryVersion===published.payload.queryVersion &&
      evidence.replayInput.computedAt===published.payload.computedAt);
    if(evidence.replayInput.kind==='SOURCE_INVALID_OUTAGE'){
      check(rawHashes.has(evidence.replayInput.provenance?.rawHash),'RAW_EVIDENCE_MISSING');
      const rebuilt=sourceInvalidOutageCandidate(evidence.replayInput);
      check(rebuilt.candidateHash===published.payloadHash &&
        canonical(rebuilt.candidate)===canonical(published.payload));
      check(point.h===null && typeof point.unavailableReason==='string' &&
        point.unavailableReason.length>0);
      continue;
    }
    check(Array.isArray(evidence.replayInput.observations) &&
      evidence.replayInput.observations.every(o=>rawHashes.has(o.rawHash)),'RAW_EVIDENCE_MISSING');
    const calculated=replay(evidence.replayInput);
    check(calculated.candidateHash===published.payloadHash && canonical(calculated.candidate)===canonical(published.payload));
    if (point.h!==null) {
      const now=BigInt(published.payload.activityNowQ12), week=BigInt(published.payload.activity7dQ12);
      check(week>0n && BigInt(point.h.denominator)>0n);
      const capped=now>5n*week?5n*week:now;
      check(BigInt(point.h.numerator)*week===BigInt(point.h.denominator)*capped);
    } else check(typeof point.unavailableReason==='string' && point.unavailableReason.length>0);
  }
  check(payloadHash(payload)===packet.payloadHash);
  return true;
}
