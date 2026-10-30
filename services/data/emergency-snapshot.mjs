import { hash } from './index.mjs';

const check=(ok)=>{if(!ok)throw new Error('EMERGENCY_SNAPSHOT_REQUIRED');};
const hex=bytes=>Buffer.from(bytes).toString('hex');

// Select the latest finalized, valid snapshot that existed when the outage
// began. Recheck its account and signature against Devnet before freezing a
// fallback price. Missing or retired evidence fails closed.
export async function readEmergencySnapshot({repository,market,incident,readAccount,readSignatureStatus}) {
  check(repository?.read && readAccount && readSignatureStatus &&
    Number.isSafeInteger(incident?.startedAt));
  const state=await repository.read();
  const eligible=Object.values(state.snapshots??{}).filter(row=>{
    const published=row?.published,payload=published?.payload;
    return row.market?.address===market.address &&
      published?.finality==='finalized' &&
      ['VALID','LOW_ACTIVITY'].includes(payload?.dataStatus) &&
      Number.isSafeInteger(published.publishedAt) && published.publishedAt<=incident.startedAt &&
      Number.isSafeInteger(payload.dataThrough) && payload.dataThrough<=incident.startedAt;
  }).sort((a,b)=>{
    const left=BigInt(a.candidate.sequence),right=BigInt(b.candidate.sequence);
    return left===right?0:left>right?-1:1;
  });
  const row=eligible[0],published=row?.published,payload=published?.payload;
  check(row && row.candidateHash===published.payloadHash &&
    hash(row.candidate)===published.payloadHash && hash(payload)===published.payloadHash &&
    published.chain?.cluster===market.cluster &&
    published.chain.programId===market.programId &&
    payload.marketId===market.address && typeof published.signature==='string' &&
    published.signature.length>0 && /^\d+$/.test(published.slot));
  const [account,status]=await Promise.all([
    readAccount(market.address,BigInt(payload.sequence),market.programId),
    readSignatureStatus(published.signature)]);
  check(account?.address===published.chain.address &&
    account.data?.market===market.address && account.data.sequence===BigInt(payload.sequence) &&
    hex(account.data.payloadHash)===published.payloadHash &&
    Number(account.data.publishedAt)===published.publishedAt &&
    status?.err===null && status.confirmationStatus==='finalized' &&
    String(status.slot)===published.slot);
  return published;
}
