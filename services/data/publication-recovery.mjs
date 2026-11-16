import {hash} from './index.mjs';
const decimal=x=>typeof x==='string' && /^(0|[1-9][0-9]*)$/.test(x);
export function validateExpiryRecovery(job, proof) {
  if(!proof || proof.version!==1 || proof.kind!=='QUIESCENT_RECENT_BLOCKHASH_EXPIRY' ||
    proof.marketId!==job.market?.address || proof.sequence!==job.sequence ||
    proof.candidateHash!==job.candidateHash || proof.originalSignature!==job.signature ||
    hash(job.candidate)!==job.candidateHash || proof.programId!==job.market?.programId || job.market?.cluster!=='devnet' ||
    proof.genesisHash!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' ||
    !proof.producerId || !proof.producerStopped || !proof.producerStillStopped ||
    !Number.isSafeInteger(proof.capturedAt) || !Number.isSafeInteger(proof.verifiedAt) ||
    !Number.isSafeInteger(proof.producerStoppedAt) || !Number.isSafeInteger(proof.boundaryBlockTime) ||
    proof.boundaryBlockTime<proof.producerStoppedAt || proof.capturedAt<proof.producerStoppedAt ||
    !decimal(proof.boundarySlot) || !decimal(proof.finalizedSlot) ||
    BigInt(proof.finalizedSlot)<BigInt(proof.boundarySlot) ||
    proof.verifiedAt<proof.capturedAt || !proof.boundaryBlockhash ||
    !decimal(proof.lastValidBlockHeight) || !decimal(proof.finalizedBlockHeight) ||
    BigInt(proof.finalizedBlockHeight)<=BigInt(proof.lastValidBlockHeight) ||
    proof.boundaryBlockhashValid!==false || proof.snapshotExists!==false ||
    proof.nextSequence!==job.sequence || proof.signatureStatus!==null ||
    proof.candidateConfigVersion!==job.candidate?.configVersion ||
    !decimal(proof.configVersion) || !decimal(proof.candidateConfigVersion) ||
    BigInt(proof.configVersion)<BigInt(proof.candidateConfigVersion) ||
    proof.queryVersion!==job.candidate?.queryVersion || proof.queryHash!==job.candidate?.queryHash)
    throw Error('PUBLICATION_EXPIRY_PROOF_INVALID');
  return true;
}
export function isPendingPublication(job) {
  if(job.state==='FINALIZED')return false;
  if(job.state!=='EXPIRED_UNLANDED')return true;
  try {
    validateExpiryRecovery(job,job.expiryRecovery);
    return job.expiryRecoveryHash!==hash(job.expiryRecovery);
  } catch { return true; }
}
export function expireUnlandedPublication(job,proof) {
  if(!['REQUESTING','SUBMITTED'].includes(job.state))throw Error('PUBLICATION_RECOVERY_STATE_INVALID');
  validateExpiryRecovery(job,proof);
  return {...job,state:'EXPIRED_UNLANDED',previousState:job.state,
    expiryRecovery:proof,expiryRecoveryHash:hash(proof)};
}
