import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout} from 'node:timers/promises';
import * as chain from '../clients/chain/dist/index.js';
import {formulaVersionBytes} from '../clients/chain/encoding.mjs';
import {replaceJournal} from './atomic-rename.mjs';
const kit=createRequire(new URL('../clients/chain/package.json',import.meta.url))('@solana/kit');
const DEVNET='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const check=(ok,code)=>{if(!ok)throw new Error(code);};

export async function initializeCore({admin,publisher,proofAuthority,transport,rpc,journal,execute=false,signer=null}) {
  check(await rpc.getGenesisHash().send()===DEVNET,'DEVNET_GENESIS_REQUIRED');
  const program=await transport.getFinalizedAccount(chain.ANTE_UP_PROGRAM_ADDRESS);
  check(program.exists && program.executable,'PROGRAM_NOT_DEPLOYED');
  const [config]=await chain.findConfigPda(),[admission]=await chain.findAdmissionPda();
  const scope={programId:chain.ANTE_UP_PROGRAM_ADDRESS,admin,publisher,proofAuthority,config,admission};
  const saved=await journal.read();
  if(saved)check(JSON.stringify(saved.scope)===JSON.stringify(scope),'CORE_JOURNAL_SCOPE_MISMATCH');
  async function verified() {
    const existing=await transport.getFinalizedAccount(config);
    if(!existing.exists)return false;
    const {data:c}=await chain.readFinalizedConfig(transport);
    const {data:a}=await chain.readFinalizedAdmission(transport);
    check(c.admin===admin && c.publisher===publisher && c.proofAuthority===proofAuthority &&
      Buffer.from(c.formulaVersion).equals(Buffer.from(formulaVersionBytes('h3-d7-q12-v1'))) && a.admin===admin,
      'CORE_CONFIG_MISMATCH');
    return true;
  }
  if(await verified())return {state:'COMPLETE',...scope,signature:saved?.signature??null};
  if(saved?.signature)return {state:'PENDING_RECONCILIATION',...scope,signature:saved.signature,
    status:await transport.getSignatureStatus(saved.signature)};
  if(!execute)return {state:'READY',...scope};
  check(signer?.address===admin,'CORE_ADMIN_SIGNER_MISMATCH');
  const ix=await chain.getInitializeInstructionAsync({admin:signer,publisher,proofAuthority,
    formulaVersion:formulaVersionBytes('h3-d7-q12-v1')});
  const lifetime=await transport.getLatestBlockhash();
  const message=kit.appendTransactionMessageInstruction(ix,kit.setTransactionMessageLifetimeUsingBlockhash(
    {...lifetime,blockhash:kit.blockhash(lifetime.blockhash)},
    kit.setTransactionMessageFeePayer(admin,kit.createTransactionMessage({version:0}))));
  const signed=await kit.signTransactionWithSigners([signer],kit.compileTransaction(message));
  check(kit.isFullySignedTransaction(signed),'CORE_SIGNATURE_INCOMPLETE');
  const signature=kit.getSignatureFromTransaction(signed);
  await journal.write({scope,signature});
  const wire=kit.getBase64Decoder().decode(kit.getTransactionEncoder().encode(signed));
  try {check(await transport.sendTransaction(wire)===signature,'CORE_SIGNATURE_MISMATCH');}
  catch {return {state:'PENDING_RECONCILIATION',...scope,signature};}
  for(let i=0;i<12;i++){
    const status=await transport.getSignatureStatus(signature);
    check(!status?.err,'CORE_TRANSACTION_FAILED');
    if(status?.confirmationStatus==='finalized' && await verified())return {state:'COMPLETE',...scope,signature};
    await setTimeout(2000);
  }
  return {state:'PENDING_RECONCILIATION',...scope,signature};
}

async function main() {
  check(process.argv.slice(2).every(x=>x==='--execute'),'CORE_UNKNOWN_ARGUMENT');
  const env=process.env,execute=process.argv.includes('--execute');
  const endpoint=env.ANTE_UP_RPC_URL??'https://api.devnet.solana.com';
  const admin=kit.address(env.ANTE_UP_ADMIN),publisher=kit.address(env.ANTE_UP_PUBLISHER),
    proofAuthority=kit.address(env.ANTE_UP_PROOF_AUTHORITY);
  const path=env.ANTE_UP_CORE_JOURNAL;
  check(path,'CORE_JOURNAL_REQUIRED');
  const journal={async read(){try{return JSON.parse(await readFile(path,'utf8'));}
    catch(e){if(e.code==='ENOENT')return null;throw e;}},
    async write(value){await mkdir(dirname(path),{recursive:true});const temp=`${path}.tmp`;
      await writeFile(temp,JSON.stringify(value),{mode:0o600});await replaceJournal(temp,path);}};
  const signer=execute?await kit.createKeyPairSignerFromBytes(Uint8Array.from(
    JSON.parse(await readFile(env.ANTE_UP_ADMIN_KEYPAIR_FILE,'utf8')))):null;
  const result=await initializeCore({admin,publisher,proofAuthority,execute,signer,journal,
    rpc:kit.createSolanaRpc(endpoint),transport:chain.createKitChainTransport(endpoint)});
  process.stdout.write(JSON.stringify(result)+'\n');
  if(result.state==='PENDING_RECONCILIATION')process.exitCode=2;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(e=>{process.stderr.write(`${e.message}\n`);process.exitCode=1;});
