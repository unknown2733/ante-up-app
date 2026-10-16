import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,rm,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createJournaledUpload,signedItemSize} from './upload-journal.mjs';
const require=createRequire(import.meta.url),{ArweaveSigner,DataItem}=require('@dha-team/arbundles');

test('lost upload response resumes identical signed bytes after restart and caches its receipt',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ante-upload-'));
 try{
  const signer=new ArweaveSigner(generateKeyPairSync('rsa',{modulusLength:4096}).privateKey.export({format:'jwk'}));
  const input={data:Buffer.from('source'),dataItemOpts:{tags:[{name:'Ante-Up-Content-Hash',value:'a'.repeat(64)}]}};
  const estimated=await signedItemSize({data:input.data,tags:input.dataItemOpts.tags,signer});
  const sent=[];
  const uploadSignedDataItem=async args=>{
   const chunks=[];for await(const chunk of args.dataItemStreamFactory())chunks.push(chunk);
   const bytes=Buffer.concat(chunks);sent.push(bytes);
   if(sent.length===1)throw Error('RESPONSE_LOST_AFTER_ACCEPTANCE');
   return {id:new DataItem(bytes).id,winc:'0',optional:undefined,helper:()=>{}};
  };
  await assert.rejects(createJournaledUpload({directory,signer,uploadSignedDataItem})(input),/RESPONSE_LOST/);
  await assert.rejects(createJournaledUpload({directory,signer,uploadSignedDataItem})({...input,data:Buffer.from('different')}),/STAGED_ITEM_MISMATCH/);
  assert.equal(sent.length,1);
  const receipt=await createJournaledUpload({directory,signer,uploadSignedDataItem})(input);
  assert.deepEqual(sent[0],sent[1]);assert.equal(receipt.id,new DataItem(sent[0]).id);
  assert.equal(estimated,sent[0].length);
  assert.deepEqual(await createJournaledUpload({directory,signer,uploadSignedDataItem})(input),receipt);
  assert.equal(sent.length,2);
 }finally{
  for(const extension of ['item','json'])await rm(join(directory,`${'a'.repeat(64)}.${extension}`),{force:true});
  await rmdir(directory);
 }
});
