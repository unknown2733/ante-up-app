import { sha256 } from './index.mjs';
import {gzipSync,gunzipSync} from 'node:zlib';

const check = (ok,code='INVALID_INPUT') => { if (!ok) throw new Error(code); };
const itemId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id);
export function encodeStorageContent(content){
  const original=Buffer.from(content,'utf8');
  const compressed=original.length>=16_384?gzipSync(original,{level:9}):null;
  return compressed && compressed.length<original.length ?
    {bytes:compressed,type:'application/gzip',encoding:'gzip'} :
    {bytes:original,type:'application/json',encoding:'identity'};
}
export const storageTags=(stored,contentHash)=>[
 {name:'Content-Type',value:stored.type},{name:'App-Name',value:'Ante-Up-Evidence'},
 {name:'Ante-Up-Content-Hash',value:contentHash},{name:'Ante-Up-Encoding',value:stored.encoding},
 {name:'Ante-Up-Stored-Hash',value:sha256(stored.bytes)}];

// Dynamic import makes SDK construction explicit. Never call from a read API.
export async function createTurboClient({privateKey}) {
  check(privateKey, 'MISSING_TURBO_SIGNER');
  const { TurboFactory } = await import('@ardrive/turbo-sdk');
  return TurboFactory.authenticated({privateKey});
}

// turbo is an authenticated @ardrive/turbo-sdk client. receiptVerifier must
// implement the allowlisted service key + receipt-version signature rules.
export function createTurboStorageAdapter({turbo,fetcher=globalThis.fetch,
  gatewayUrl='https://turbo-gateway.com',arweaveUrl='https://arweave.net',receiptVerifier,inclusionVerifier}) {
  check(turbo && typeof turbo.upload === 'function');
  check(typeof fetcher === 'function' && typeof receiptVerifier === 'function','RECEIPT_VERIFIER_REQUIRED');
  const raw = async id => {
    check(itemId(id));
    const res = await fetcher(new URL(`/raw/${id}`,gatewayUrl),{headers:{Accept:'application/octet-stream'},signal:AbortSignal.timeout(15_000)});
    if (!res.ok) return null;
    let bytes = Buffer.from(await res.arrayBuffer());
    // Content hash refers to the exact canonical JSON, not its lossless wire encoding.
    // application/gzip (NOT Content-Encoding) avoids implicit HTTP decompression.
    if(bytes[0]===0x1f && bytes[1]===0x8b)bytes=gunzipSync(bytes,{maxOutputLength:128*1024*1024});
    return {bytes,headers:res.headers};
  };
  return {
    async upload(key,content,contentHash) {
      check(typeof key === 'string' && typeof content === 'string' && sha256(Buffer.from(content,'utf8')) === contentHash);
      const stored=encodeStorageContent(content);
      const receipt = await turbo.upload({data:stored.bytes,dataItemOpts:{tags:storageTags(stored,contentHash)}});
      check(itemId(receipt?.id),'INVALID_RECEIPT');
      // Upload receipt is acceptance, not Arweave inclusion.
      // SDK responses can add optional undefined/helper fields that never existed
      // in the JSON receipt. Preserve its JSON representation for durable journals.
      return {ref:{contentHash,arweaveItemId:receipt.id,parentTransactionId:null},receipt:JSON.parse(JSON.stringify(receipt))};
    },
    async resolve(ref) {
      if(inclusionVerifier)return inclusionVerifier.resolve(ref);
      const response=await raw(ref.arweaveItemId);
      if (!response) return null;
      check(sha256(response.bytes)===ref.contentHash,'CONTENT_MISMATCH');
      const parent=response.headers.get('x-ar-io-root-transaction-id');
      if (!itemId(parent)) return null;
      return {...ref,parentTransactionId:parent};
    },
    async fetch(ref) {
      const response=await raw(ref.arweaveItemId);
      check(response && sha256(response.bytes)===ref.contentHash,'CONTENT_MISMATCH');
      return response.bytes.toString('utf8');
    },
    async verify(ref,receipt) {
      check(receipt?.id===ref.arweaveItemId && await receiptVerifier(receipt)===true,'INVALID_RECEIPT');
      const response=await raw(ref.arweaveItemId);
      check(response && sha256(response.bytes)===ref.contentHash,'CONTENT_MISMATCH');
      const parent=inclusionVerifier?ref.parentTransactionId:response.headers.get('x-ar-io-root-transaction-id');
      check(parent===ref.parentTransactionId,'PARENT_MISMATCH');
      // Verified is a gateway base-layer verification claim; full independent
      // ANS-104 inclusion proof remains a separate deployment gate.
      const included=inclusionVerifier?await inclusionVerifier.verify(ref):response.headers.get('x-ar-io-verified')==='true';
      if (!included) return {receiptValid:true,itemId:ref.arweaveItemId,parentTransactionId:parent,
        itemIncluded:false,content:response.bytes.toString('utf8'),confirmations:0};
      // Inclusion bytes are immutable, confirmation status is not. Avoid a CDN
      // response from a previous check (including stale pre-reorg status).
      const statusUrl=new URL(`/tx/${parent}/status`,arweaveUrl);
      statusUrl.searchParams.set('observedAt',String(Date.now()));
      const status=await fetcher(statusUrl,{headers:{Accept:'application/json','Cache-Control':'no-cache'},cache:'no-store',signal:AbortSignal.timeout(15_000)});
      if (!status.ok||status.status===202) return {receiptValid:true,itemId:ref.arweaveItemId,parentTransactionId:parent,
        itemIncluded:false,content:response.bytes.toString('utf8'),confirmations:0};
      const type=status.headers?.get('content-type');
      if(type&&!type.toLowerCase().includes('json')){
        if((await status.text()).trim()==='Accepted')return {receiptValid:true,itemId:ref.arweaveItemId,parentTransactionId:parent,
          itemIncluded:false,content:response.bytes.toString('utf8'),confirmations:0};
        throw Error('INVALID_ARWEAVE_STATUS');
      }
      const json=await status.json();
      check(Number.isSafeInteger(json.number_of_confirmations) && json.number_of_confirmations>=0,'INVALID_CONFIRMATIONS');
      return {receiptValid:true,itemId:ref.arweaveItemId,parentTransactionId:parent,itemIncluded:true,
        content:response.bytes.toString('utf8'),confirmations:json.number_of_confirmations};
    }
  };
}
