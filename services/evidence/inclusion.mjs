import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
import {sha256} from './index.mjs';
const require=createRequire(import.meta.url);
const Arweave=require('arweave');
const Transaction=require('arweave/node/lib/transaction.js').default;
const {computeRootHash}=require('arweave/node/lib/merkle.js');
const {DataItem}=require('@dha-team/arbundles');
const idPattern=/^[A-Za-z0-9_-]{43}$/;
const check=(ok,code)=>{if(!ok)throw Error(code);};

// Bounded full-bundle verification for the MVP. Large bundles fail closed;
// a future range/Merkle-proof reader can remove this bandwidth bound.
export function createArweaveInclusionVerifier({fetcher=globalThis.fetch,maxBundleBytes=192*1024*1024}={}){
 const verifiedParents=new Map(),loadingParents=new Map(),arweave=Arweave.init({host:'arweave.net',protocol:'https',port:443});
 async function loadParentBytes(id){
  if(verifiedParents.has(id))return verifiedParents.get(id);
  const txResponse=await fetcher(`https://arweave.net/tx/${id}`,{signal:AbortSignal.timeout(20000)});
  if(!txResponse.ok)return null;
  const raw=await txResponse.json();
  check(raw.id===id && raw.format===2 && /^\d+$/.test(raw.data_size),'PARENT_TRANSACTION_INVALID');
  const size=Number(raw.data_size);check(Number.isSafeInteger(size)&&size>32&&size<=maxBundleBytes,'BUNDLE_SIZE_LIMIT');
  check(await arweave.transactions.verify(new Transaction(raw)),'PARENT_SIGNATURE_INVALID');
  const response=await fetcher(`https://turbo-gateway.com/raw/${id}`,{signal:AbortSignal.timeout(30000)});
  if(!response.ok)return null;
  const chunks=[];let length=0;
  for await(const chunk of response.body){length+=chunk.length;check(length<=size,'BUNDLE_LENGTH_MISMATCH');chunks.push(Buffer.from(chunk));}
  const bytes=Buffer.concat(chunks);check(bytes.length===size,'BUNDLE_LENGTH_MISMATCH');
  check(Buffer.from(await computeRootHash(bytes)).toString('base64url')===raw.data_root,'BUNDLE_ROOT_MISMATCH');
  check(bytes.subarray(8,32).every(b=>b===0),'BUNDLE_HEADER_INVALID');
  const count=Number(bytes.readBigUInt64LE(0));check(count<=100000 && 32+64*count<=bytes.length,'BUNDLE_HEADER_INVALID');
  const bundle=new Map();let offset=32+64*count;
  for(let i=0;i<count;i++){
   const header=32+64*i;
   check(bytes.subarray(header+8,header+32).every(b=>b===0),'BUNDLE_HEADER_INVALID');
   const length=Number(bytes.readBigUInt64LE(header));
   check(Number.isSafeInteger(length)&&length>0&&length<=bytes.length-offset,'BUNDLE_ITEM_LENGTH_INVALID');
   const itemId=bytes.subarray(header+32,header+64).toString('base64url');
   check(!bundle.has(itemId),'BUNDLE_DUPLICATE_ITEM');
   bundle.set(itemId,bytes.subarray(offset,offset+length));offset+=length;
  }
  check(offset===bytes.length,'BUNDLE_LENGTH_MISMATCH');
  verifiedParents.set(id,bundle);
  if(verifiedParents.size>2)verifiedParents.delete(verifiedParents.keys().next().value);
  return bundle;
 }
 async function parentBytes(id){
  if(verifiedParents.has(id))return verifiedParents.get(id);
  if(loadingParents.has(id))return loadingParents.get(id);
  const pending=loadParentBytes(id);loadingParents.set(id,pending);
  try{return await pending;}finally{loadingParents.delete(id);}
 }
 return {
  async resolve(ref){
   check(idPattern.test(ref.arweaveItemId),'INVALID_ITEM_ID');
   const response=await fetcher(`https://upload.ardrive.io/v1/tx/${ref.arweaveItemId}/status`,{signal:AbortSignal.timeout(15000)});
   if(!response.ok||response.status===202)return null;
   const type=response.headers?.get('content-type');
   if(type&&!type.toLowerCase().includes('json')){
    if((await response.text()).trim()==='Accepted')return null;
    throw Error('INVALID_UPLOAD_STATUS');
   }
   const status=await response.json();return idPattern.test(status?.bundleId??'')?{...ref,parentTransactionId:status.bundleId}:null;
  },
  async verify(ref){
   check(idPattern.test(ref.parentTransactionId),'INVALID_PARENT_ID');
   const bundle=await parentBytes(ref.parentTransactionId);if(!bundle)return false;
   const rawItem=bundle.get(ref.arweaveItemId);check(rawItem,'BUNDLE_ITEM_MISSING');
   const item=new DataItem(rawItem);
   check(item.id===ref.arweaveItemId && await item.isValid(),'BUNDLE_ITEM_INVALID');
   let bytes=item.rawData;
   if(bytes[0]===0x1f&&bytes[1]===0x8b)bytes=gunzipSync(bytes,{maxOutputLength:128*1024*1024});
   check(sha256(bytes)===ref.contentHash,'BUNDLE_CONTENT_MISMATCH');
   return true;
  }
 };
}
