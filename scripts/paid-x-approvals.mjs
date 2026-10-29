const HEX=/^[a-f0-9]{64}$/;
const ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CANDIDATE_PATH=/^\/state\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/candidates\.json$/;

export function candidatePathForDirectory(directory) {
  const path=typeof directory==='string'?`${directory}/candidates.json`:'';
  if(!CANDIDATE_PATH.test(path))throw Error('APPROVAL_CANDIDATE_PATH_INVALID');
  return path;
}

/**
 * Paid X collection is an operator decision. The state file is the only
 * approval list; a Compose service or collection config alone cannot opt in.
 */
export function validatePaidXRegistry(registry) {
  if(!registry || registry.schemaVersion!==1 || registry.maxMarkets!==5 ||
      !Array.isArray(registry.markets) || registry.markets.length>5)
    throw Error('PAID_X_APPROVAL_INVALID');
  const ids=new Set(),hashes=new Set();
  for(const item of registry.markets){
    if(!item || !ADDRESS.test(item.marketId) || !HEX.test(item.seedHex) ||
        !HEX.test(item.queryHash) || item.queryVersion!=='1' ||
        (item.candidatePath!==undefined && !CANDIDATE_PATH.test(item.candidatePath)) ||
        ids.has(item.marketId) || hashes.has(item.queryHash))
      throw Error('PAID_X_APPROVAL_INVALID');
    ids.add(item.marketId);hashes.add(item.queryHash);
  }
  return registry;
}

export function assertPaidXApproved(registry,market) {
  validatePaidXRegistry(registry);
  const approved=registry.markets.find(item=>item.marketId===market.marketId);
  if(!approved)throw Error('PAID_X_NOT_APPROVED');
  if(approved.seedHex!==market.seedHex || approved.queryHash!==market.queryHash ||
      approved.queryVersion!==market.queryVersion)
    throw Error('PAID_X_APPROVAL_MISMATCH');
}
