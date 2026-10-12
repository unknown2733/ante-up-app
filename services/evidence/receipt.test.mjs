import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,constants,createHash} from 'node:crypto';
import {deepHash} from '@dha-team/arbundles';
import * as sas from 'sas-lib';
import {createReceiptVerifier,receiptTranscript} from './receipt.mjs';
import {encodeAnteUpClaims,decodeAnteUpClaims} from './runtime.mjs';

test('receipt transcript agrees with ANS deep hash; tampering, key swaps and version changes fail',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const n=publicKey.export({format:'jwk'}).n;
 const receipt={version:'0.2.0',id:'a'.repeat(43),deadlineHeight:123,timestamp:1791800000000,public:n,winc:'0'};
 const expected=await deepHash(['Bundlr',receipt.version,receipt.id,'123','1791800000000'].map(s=>Buffer.from(s)));
 assert.deepEqual(Buffer.from(expected),receiptTranscript(receipt));
 receipt.signature=sign('sha256',expected,{key:privateKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:0}).toString('base64url');
 const address=createHash('sha256').update(Buffer.from(n,'base64url')).digest('base64url');
 const verify=createReceiptVerifier({allowedAddresses:[address]});
 assert.equal(await verify(receipt),true);
 for(const change of [{id:'b'.repeat(43)},{timestamp:receipt.timestamp+1},{version:'0.3.0'},{signature:'bad'}])assert.equal(await verify({...receipt,...change}),false);
 assert.equal(await createReceiptVerifier({allowedAddresses:['other']})(receipt),false);
 // Not signature-bound in 0.2.0: never authenticate billing using this signature.
 assert.equal(await verify({...receipt,winc:'999'}),true);
});

test('claims roundtrip through the registered SAS Borsh string schema, rejecting trailing bytes',()=>{
 const name=Buffer.from('claims'),length=Buffer.alloc(4);length.writeUInt32LE(name.length);
 const schema={layout:Uint8Array.of(12),fieldNames:Buffer.concat([length,name])};
 const claims={recordId:'record',payloadHash:'a'.repeat(64)};
 const bytes=encodeAnteUpClaims(claims);
 assert.deepEqual(decodeAnteUpClaims(bytes),claims);
 assert.equal(sas.deserializeAttestationData(schema,bytes).claims,JSON.stringify({payloadHash:'a'.repeat(64),recordId:'record'}));
 assert.throws(()=>decodeAnteUpClaims(Buffer.concat([bytes,Buffer.from('x')])),/SAS_CLAIM_ENCODING/);
});
