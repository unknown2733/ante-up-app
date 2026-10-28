// One-time, explicitly invoked Devnet gas funding for the dedicated weekly Keeper.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import * as chain from '../clients/chain/dist/index.js';

const requireChain=createRequire(new URL('../clients/chain/package.json',import.meta.url));
const kit=requireChain('@solana/kit'),system=requireChain('@solana-program/system');
const genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const destination=kit.address('5bFWvxgsS6kkpx8BpLfD7S3ZZkMAWwvJFVPgD5ocSpPw');
const source=kit.address('5Fm81PP7TXvyNJHoB4DrwWETYdfqKtc45s6WRK8qdx5e');
const env=process.env;
assert.equal(process.argv[2],'--execute');
assert.ok(env.ANTE_UP_QA_RPC_FILE&&env.ANTE_UP_QA_ADMIN_FILE);
const endpoint=(await readFile(env.ANTE_UP_QA_RPC_FILE,'utf8')).trim();
const rpc=kit.createSolanaRpc(endpoint),transport=chain.createKitChainTransport(endpoint);
assert.equal(await rpc.getGenesisHash().send(),genesis);
const signer=await kit.createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(await readFile(env.ANTE_UP_QA_ADMIN_FILE,'utf8'))));
assert.equal(signer.address,source);
const current=(await rpc.getBalance(destination,{commitment:'finalized'}).send()).value;
if(current>=200_000_000n){console.log(JSON.stringify({state:'already-funded',lamports:current.toString()}));process.exit(0);}
assert.equal(current,0n,'unexpected partial balance; reconcile before another transfer');
const sourceBalance=(await rpc.getBalance(source,{commitment:'finalized'}).send()).value;
assert.ok(sourceBalance>=400_000_000n,'deployer reserve too low');
let message=kit.createTransactionMessage({version:0});
message=kit.setTransactionMessageFeePayerSigner(signer,message);
const lifetime=await transport.getLatestBlockhash();
message=kit.setTransactionMessageLifetimeUsingBlockhash({...lifetime,blockhash:kit.blockhash(lifetime.blockhash)},message);
message=kit.appendTransactionMessageInstruction(system.getTransferSolInstruction({source:signer,destination,amount:200_000_000n}),message);
const transaction=await kit.signTransactionMessageWithSigners(message);
const signature=kit.getSignatureFromTransaction(transaction);
const wire=kit.getBase64Decoder().decode(kit.getTransactionEncoder().encode(transaction));
try {assert.equal(await transport.sendTransaction(wire),signature);}
catch(error){throw Error(`FUNDING_SUBMISSION_UNKNOWN:${signature}:${String(error.message).replace(/https?:\/\/[^\s]+/g,'[RPC_REDACTED]')}`);}
for(let i=0;i<40;i++){
 const status=await transport.getSignatureStatus(signature);
 if(status?.err)throw Error(`FUNDING_FAILED:${signature}`);
 if(status?.confirmationStatus==='finalized'){
  const balance=(await rpc.getBalance(destination,{commitment:'finalized'}).send()).value;
  assert.ok(balance>=200_000_000n);
  console.log(JSON.stringify({state:'finalized',signature,lamports:balance.toString()}));
  process.exit(0);
 }
 await new Promise(resolve=>setTimeout(resolve,1500));
}
throw Error(`FUNDING_CONFIRMATION_UNKNOWN:${signature}`);
