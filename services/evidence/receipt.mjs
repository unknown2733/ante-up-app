import {createHash,createPublicKey,verify,constants} from 'node:crypto';

// Protocol transcript documented by permaweb/turbo-upload-service,
// src/utils/signReceipt.ts (receipt 0.2.0). Fees/cache fields are NOT signed.
const hash=value=>createHash('sha384').update(value).digest();
export function receiptTranscript(receipt){
  const fields=['Bundlr',receipt.version,receipt.id,String(receipt.deadlineHeight),String(receipt.timestamp)];
  let acc=hash(Buffer.from(`list${fields.length}`));
  for(const field of fields){
    const bytes=Buffer.from(field),blob=hash(Buffer.concat([hash(Buffer.from(`blob${bytes.length}`)),hash(bytes)]));
    acc=hash(Buffer.concat([acc,blob]));
  }
  return acc;
}
export function createReceiptVerifier({allowedAddresses}){
  if(!Array.isArray(allowedAddresses)||!allowedAddresses.length)throw Error('RECEIPT_TRUST_REQUIRED');
  return async receipt=>{
    try{
      if(receipt?.version!=='0.2.0'||!/^[A-Za-z0-9_-]{43}$/.test(receipt.id)||
        !Number.isSafeInteger(receipt.deadlineHeight)||receipt.deadlineHeight<0||
        !Number.isSafeInteger(receipt.timestamp)||receipt.timestamp<=0||
        typeof receipt.public!=='string'||typeof receipt.signature!=='string')return false;
      const address=createHash('sha256').update(Buffer.from(receipt.public,'base64url')).digest('base64url');
      if(!allowedAddresses.includes(address))return false;
      const key=createPublicKey({key:{kty:'RSA',n:receipt.public,e:'AQAB'},format:'jwk'});
      return verify('sha256',receiptTranscript(receipt),{key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:0},Buffer.from(receipt.signature,'base64url'));
    }catch{return false;}
  };
}
