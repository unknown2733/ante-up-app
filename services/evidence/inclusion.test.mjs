import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createRequire} from 'node:module';
import {createArweaveInclusionVerifier} from './inclusion.mjs';
import {sha256} from './index.mjs';
const require=createRequire(import.meta.url);
const Arweave=require('arweave'),{createData,ArweaveSigner,bundleAndSignData}=require('@dha-team/arbundles');

test('verify real parent signature/root and ANS-104 item; reject altered bundle bytes and excessive size',async()=>{
 const key=generateKeyPairSync('rsa',{modulusLength:4096}).privateKey.export({format:'jwk'});
 const content=Buffer.from('{"actual":"signed fixture"}'),item=createData(content,new ArweaveSigner(key));await item.sign(new ArweaveSigner(key));
 const bundle=await bundleAndSignData([item],new ArweaveSigner(key)),bytes=bundle.getRaw();
 const arweave=Arweave.init({host:'arweave.net',protocol:'https',port:443});
 const tx=await arweave.createTransaction({data:bytes,last_tx:'a'.repeat(43),reward:'1'},key);await arweave.transactions.sign(tx,key);
 const ref={arweaveItemId:item.id,parentTransactionId:tx.id,contentHash:sha256(content)};
 let corrupt=false;
 const fetcher=async url=>url.includes('/status')?{ok:true,json:async()=>({bundleId:tx.id})}:
  url.includes('/tx/')?{ok:true,json:async()=>tx.toJSON()}:
  {ok:true,body:(async function*(){const value=Buffer.from(bytes);if(corrupt)value[value.length-1]^=1;yield value;})()};
 const verifier=createArweaveInclusionVerifier({fetcher});
 assert.deepEqual(await verifier.resolve(ref),ref);assert.equal(await verifier.verify(ref),true);
 assert.deepEqual(await verifier.readVerified(ref),content);
 let parentFetches=0;
 const counted=async url=>{if(url.includes('/tx/'))parentFetches++;return fetcher(url);};
 const concurrent=createArweaveInclusionVerifier({fetcher:counted});
 assert.deepEqual(await Promise.all([concurrent.verify(ref),concurrent.verify(ref)]),[true,true]);
 assert.equal(parentFetches,1);
 corrupt=true;
 await assert.rejects(()=>createArweaveInclusionVerifier({fetcher}).verify(ref),/BUNDLE_ROOT_MISMATCH/);
 await assert.rejects(()=>createArweaveInclusionVerifier({fetcher,maxBundleBytes:32}).verify(ref),/BUNDLE_SIZE_LIMIT/);
 const timeout=Object.assign(new Error('aborted'),{name:'TimeoutError'});
 await assert.rejects(()=>createArweaveInclusionVerifier({fetcher:async url=>{if(url.includes('/raw/'))throw timeout;return fetcher(url);}}).verify(ref),/PARENT_BUNDLE_FETCH_TIMEOUT/);
});

test('accepted parent metadata waits for indexing without parsing text as JSON',async()=>{
 const id='a'.repeat(43);
 const verifier=createArweaveInclusionVerifier({fetcher:async url=>{
  if(url.includes('/tx/'))return {ok:true,status:202,json:async()=>{throw Error('SHOULD_NOT_PARSE');}};
  throw Error('SHOULD_NOT_FETCH_BUNDLE');
 }});
 assert.equal(await verifier.verify({arweaveItemId:id,parentTransactionId:id,contentHash:'b'.repeat(64)}),false);
});

test('metadata network failure is classified and an unsuccessful parent is not cached',async()=>{
 const id='a'.repeat(43);let calls=0;
 const verifier=createArweaveInclusionVerifier({fetcher:async()=>{
  calls++;if(calls===1)throw new TypeError('fetch failed');
  return {ok:true,status:202};
 }});
 const ref={arweaveItemId:id,parentTransactionId:id,contentHash:'b'.repeat(64)};
 await assert.rejects(()=>verifier.readVerified(ref),/PARENT_METADATA_UNAVAILABLE/);
 assert.equal(await verifier.readVerified(ref),null);assert.equal(calls,2);
});

test('parent metadata rate limits and server errors do not masquerade as unconfirmed inclusion',async()=>{
 for(const status of [429,503]){
  const id='a'.repeat(43),verifier=createArweaveInclusionVerifier({fetcher:async()=>({ok:false,status})});
  await assert.rejects(()=>verifier.readVerified({arweaveItemId:id,parentTransactionId:id,contentHash:'b'.repeat(64)}),/PARENT_METADATA_UNAVAILABLE/);
 }
});
