import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer as createVite} from '../../apps/web/node_modules/vite/dist/node/index.js';
import {createApp} from '../../services/api/src/app.ts';
import {LiveStore} from '../../services/api/src/live-store.ts';
import {ANTE_UP_PROGRAM_ADDRESS, getFinanceConfigEncoder, findFinanceConfigPda} from '../../clients/chain/dist/index.js';
import {FinalizedFinancialAccounts, FirstSliceFinancialReader, TOKEN_PROGRAM} from '../../services/api/src/financial-chain.ts';
import {KitFirstSliceFinancialTransactionAdapter} from '../../services/api/src/financial-transaction.ts';
import {SqliteFinancialRegistrationStore} from '../../services/api/src/registration.ts';

const kit = createRequire(new URL('../../clients/chain/package.json',import.meta.url))('@solana/kit');
const {address, getAddressEncoder, getBase58Decoder, getTransactionEncoder} = kit;

// Production web verifier/controller, API reader/builder/persistence/authentication,
// generated instructions and Ed25519 signatures. RPC accounts and receipts are
// injected: no SBF executes and these fixtures do not establish token transfers.
test('financial web/API preserves unknown signed faucet across both restarts without rebroadcast',async()=>{
  const dir=await mkdtemp(join(process.cwd(),'.financial-integration-'));
  let vite,store,registrations;
  try {
    const now=1_800_000_000;
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');
    const owner=address(getBase58Decoder().decode(publicKey.export({format:'der',type:'spki'}).subarray(-32)));
    const [financeConfig]=await findFinanceConfigPda();
    const mint=address('So11111111111111111111111111111111111111112');
    const configData=getFinanceConfigEncoder().encode({admin:owner,paymentMint:mint,protocolTreasury:owner,
      faucetAmount:1_000_000_000n,faucetCooldown:86400n,faucetTotalLimit:100_000_000_000n,
      faucetMinted:0n,supportedMarkets:0,supportSpent:0n});
    const mintData=Buffer.alloc(82);mintData.writeUInt32LE(1,0);
    mintData.set(getAddressEncoder().encode(financeConfig),4);mintData[44]=6;mintData[45]=1;
    const accounts=new Map([[financeConfig,{ownerProgramId:ANTE_UP_PROGRAM_ADDRESS,data:configData}],
      [mint,{ownerProgramId:TOKEN_PROGRAM,data:mintData}]]);
    // No destination ATA exists: the generated transaction must create it first.
    const state=new FinalizedFinancialAccounts({cluster:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS,
      accounts:{async get(account){return accounts.get(account)??null}}});
    registrations=new SqliteFinancialRegistrationStore(join(dir,'registration.sqlite'));
    const financial=new FirstSliceFinancialReader(state,registrations);
    const transactions=new KitFirstSliceFinancialTransactionAdapter({state,reader:financial,now:()=>now,
      blockhashes:{async latest(){return {blockhash:'11111111111111111111111111111111',lastValidBlockHeight:999n}}}});
    const transport={async getFinalizedAccount(account){const raw=accounts.get(account);
      return raw?{exists:true,address:account,programAddress:raw.ownerProgramId,data:raw.data,
        executable:false,lamports:1n,space:BigInt(raw.data.length)}:{exists:false,address:account}}};
    const receipts=new Map(),storageMap=new Map();
    const storage={getItem:k=>storageMap.get(k)??null,setItem:(k,v)=>storageMap.set(k,v),removeItem:k=>storageMap.delete(k)};
    const read={mode:'localnet',async markets(){return []},async records(){return []},async proofs(){return []},async heldCalculationWallets(){return new Set()}};
    const chain={async get(sig){return receipts.get(sig)??null},async discover(){return [...receipts].map(([signature,receipt])=>({signature,receipt}))}};
    store=new LiveStore(join(dir,'live.sqlite'));
    const makeApp=()=>createApp({mode:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS,read,financial,
      financialTransactions:transactions,liveStore:store,chain,now:()=>now});
    let app=makeApp(),broadcasts=0;
    const fetcher=(url,init)=>app.handle(new Request(url,init));
    vite=await createVite({root:fileURLToPath(new URL('../../apps/web',import.meta.url)),
      optimizeDeps:{noDiscovery:true},server:{middlewareMode:true,hmr:false},appType:'custom'});
    const {createLiveFreeFlow}=await vite.ssrLoadModule('/src/liveFree.ts');
    const {createLiveFinancialFlow}=await vite.ssrLoadModule('/src/liveFinancial.ts');
    const {createFinancialInstructionVerifier}=await vite.ssrLoadModule('/src/financialInstructionVerifier.ts');
    const verifyInstruction=createFinancialInstructionVerifier(transport,()=>now);
    const wallet={address:owner,cluster:'localnet',supportedTransactionVersions:new Set([0]),signer:{
      async signAndSendTransactions(list){broadcasts++;assert.equal(list.length,1);
        const bytes=sign(null,Buffer.from(list[0].messageBytes),privateKey);
        const signature=getBase58Decoder().decode(bytes);
        receipts.set(signature,{status:'finalized',wireBase64:Buffer.from(getTransactionEncoder().encode({
          ...list[0],signatures:{...list[0].signatures,[owner]:bytes}})).toString('base64')});
        throw new Error('Injected lost wallet response after broadcast');
      }}};
    const authorization=createLiveFreeFlow({baseUrl:'http://integration.test',getWallet:()=>wallet,fetcher,
      canSignMessage:()=>true,signMessage:async bytes=>sign(null,Buffer.from(bytes),privateKey),nowSeconds:()=>now});
    const makeFlow=()=>createLiveFinancialFlow({baseUrl:'http://integration.test',getWallet:()=>wallet,
      authorize:authorization.authorize,fetcher,nowSeconds:()=>now,storage,verifyInstruction});
    let flow=makeFlow();
    const quoted=await flow.quote({action:'faucet',marketId:null});assert.equal(quoted.kind,'quote');
    const result=await flow.execute(quoted.quote);assert.equal(result.state,'UNKNOWN',JSON.stringify(result));
    assert.equal(result.signature,null);assert.equal(broadcasts,1);
    await assert.rejects(flow.quote({action:'faucet',marketId:null}),/pending/);
    store.close();store=new LiveStore(join(dir,'live.sqlite'));app=makeApp();flow=makeFlow();
    assert.equal(flow.pending(wallet).requestId,result.requestId);
    const recovered=await flow.recheck();assert.equal(recovered.state,'FINALIZED',JSON.stringify(recovered));
    assert.ok(recovered.signature);assert.equal(flow.pending(wallet),null);assert.equal(broadcasts,1);
  } finally {
    if(vite)await vite.close();if(store)store.close();if(registrations)registrations.close();
    await rm(dir,{recursive:true,force:true});
  }
});
