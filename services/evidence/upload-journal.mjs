import {readFile,mkdir,open} from 'node:fs/promises';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createRequire} from 'node:module';
import {canonical} from './index.mjs';
const require=createRequire(import.meta.url);
const {DataItem,createData}=require('@dha-team/arbundles');
const check=(ok,code)=>{if(!ok)throw Error(code);};

// Preflight measures the exact signed bytes charged by Turbo without sending
// them. No item is persisted here; actual transport still journals its item.
export async function signedItemSize({data,tags,signer}){
 const item=createData(data,signer,{tags});await item.sign(signer);
 return item.getRaw().length;
}

async function persistOnce(path,bytes){
 const handle=await open(path,'wx',0o600);
 try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
}

// Single-worker, durable signed bytes BEFORE transport. An ambiguous response
// is retried using the identical signed item/ID, never a fresh signature.
// A partial/corrupt journal fails closed and requires operator reconciliation.
export function createJournaledUpload({directory,signer,uploadSignedDataItem}){
 check(directory&&signer&&typeof uploadSignedDataItem==='function','UPLOAD_JOURNAL_CONFIG');
 return async input=>{
  const tags=input.dataItemOpts?.tags,hash=tags?.find(t=>t.name==='Ante-Up-Content-Hash')?.value;
  check(/^[a-f0-9]{64}$/.test(hash)&&Buffer.isBuffer(input.data),'UPLOAD_HASH_REQUIRED');
  await mkdir(directory,{recursive:true});
  const receiptPath=join(directory,`${hash}.json`),itemPath=join(directory,`${hash}.item`);
  // Existing pre-journal accepted receipts remain usable, including recovery.
  try{return JSON.parse(await readFile(receiptPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  let bytes;
  try{bytes=await readFile(itemPath);}catch(e){
   if(e.code!=='ENOENT')throw e;
   const item=createData(input.data,signer,{tags});await item.sign(signer);
   try{await persistOnce(itemPath,item.getRaw());}catch(error){if(error.code!=='EEXIST')throw error;}
   bytes=await readFile(itemPath);
  }
  const item=new DataItem(bytes);
  check(await item.isValid()&&Buffer.from(item.rawOwner).equals(Buffer.from(signer.publicKey))&&
   Buffer.from(item.rawData).equals(input.data)&&canonical(item.tags)===canonical(tags),'STAGED_ITEM_MISMATCH');
  const receipt=JSON.parse(JSON.stringify(await uploadSignedDataItem({
   dataItemStreamFactory:()=>Readable.from(bytes),dataItemSizeFactory:()=>bytes.length})));
  check(receipt.id===item.id,'UPLOAD_RECEIPT_ID_MISMATCH');
  await persistOnce(receiptPath,JSON.stringify(receipt));return receipt;
 };
}
