import * as defaultSdk from 'sas-lib';
import { canonical, fetchManifest, payloadHash } from './index.mjs';
import { verifySemanticPacket } from './semantic.mjs';

const check=(ok,code='INVALID_INPUT')=>{if(!ok)throw new Error(code);};

// The schema-specific encoder/decoder and transaction sender are explicit:
// sas-lib constructs instructions and reads accounts; it cannot infer the
// Ante Up schema or create an authorized issuer key on its own.
export function createSasAdapter({rpc,credential,schema,payer,authority,nonceForJob,
  encodeClaims,decodeClaims,sendInstruction,semanticPacketProvider,chainVerifier,storage,
  expiryAt,sdk=defaultSdk}) {
  check(rpc && credential && schema && payer && authority && storage,'SAS_CONFIG_REQUIRED');
  check([nonceForJob,encodeClaims,decodeClaims,sendInstruction,semanticPacketProvider,chainVerifier,expiryAt]
    .every(x=>typeof x==='function'),'SAS_CONFIG_REQUIRED');
  const verifiedClaims=new Map();
  async function location(jobId) {
    const nonce=await nonceForJob(jobId);
    check(typeof nonce==='string' && nonce.length>0,'INVALID_NONCE');
    const [address]=await sdk.deriveAttestationPda({credential,schema,nonce});
    return {nonce,address};
  }
  async function validateMeaning(jobId,hash,manifestRef,payload) {
    check(/^[a-f0-9]{64}$/.test(hash) && manifestRef?.contentHash===hash,'INVALID_EVIDENCE');
    check(payloadHash(payload)===hash,'INVALID_EVIDENCE');
    const key=`${jobId}:${hash}:${manifestRef.arweaveItemId}:${manifestRef.parentTransactionId}`;
    if (verifiedClaims.has(key)) return verifiedClaims.get(key);
    const pending=(async()=>{
      const archived=await fetchManifest(storage,{payloadHash:hash,manifestRef});
      check(canonical(archived)===canonical(payload),'MANIFEST_MISMATCH');
      const packet=await semanticPacketProvider(jobId,payload);
      check(packet && packet.payloadHash===hash,'INVALID_EVIDENCE');
      await verifySemanticPacket(payload,packet,chainVerifier,storage);
      return {jobId,payloadHash:hash,manifestItemId:manifestRef.arweaveItemId,
        manifestParentId:manifestRef.parentTransactionId,recordId:payload.record.id};
    })();
    verifiedClaims.set(key,pending);
    try { return await pending; }
    catch(error) { if(verifiedClaims.get(key)===pending)verifiedClaims.delete(key); throw error; }
  }
  async function lookupIssue(jobId,hash=null,manifestRef=null,payload=null) {
    const expected=hash===null ? null : await validateMeaning(jobId,hash,manifestRef,payload);
    const {address}=await location(jobId);
    const account=await sdk.fetchMaybeAttestation(rpc,address,{commitment:'finalized'});
    if (account?.exists === false) return null;
    check(account?.exists === true && account.address === address &&
      account.programAddress===defaultSdk.SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,'SAS_ACCOUNT_MISMATCH');
    check(account.data.credential===credential && account.data.schema===schema &&
      account.data.signer===authority.address,'SAS_ACCOUNT_MISMATCH');
    check(typeof account.data.expiry==='bigint' && account.data.expiry>BigInt(Math.floor(Date.now()/1000)),
      'SAS_ATTESTATION_EXPIRED');
    const claims=decodeClaims(account.data.data);
    check(claims && typeof claims.payloadHash==='string' && claims.jobId===jobId,'SAS_CLAIM_MISMATCH');
    if (expected) check(canonical(claims)===canonical(expected),'SAS_CLAIM_MISMATCH');
    return {sasId:address,finalized:true};
  }
  return {
    lookupIssue,
    async issue(jobId,hash,manifestRef,payload) {
      check(typeof jobId==='string','INVALID_EVIDENCE');
      const claims=await validateMeaning(jobId,hash,manifestRef,payload);
      const previous=await lookupIssue(jobId,hash,manifestRef,payload);
      if (previous) return previous;
      const {nonce,address}=await location(jobId);
      const data=encodeClaims(claims);
      check(data instanceof Uint8Array && data.length>0,'SAS_SCHEMA_ENCODING');
      const expiry=await expiryAt(jobId);
      check(Number.isSafeInteger(expiry) && expiry>Math.floor(Date.now()/1000),'INVALID_EXPIRY');
      const instruction=sdk.getCreateAttestationInstruction({payer,authority,credential,schema,
        attestation:address,nonce,data,expiry});
      const submission=await sendInstruction({jobId,address,instruction});
      if (submission?.finalized) return await lookupIssue(jobId,hash,manifestRef,payload) ?? {pending:true};
      return {pending:true};
    }
  };
}
