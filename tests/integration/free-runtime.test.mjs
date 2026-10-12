import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from '../../apps/web/node_modules/vite/dist/node/index.js';
import { createApp } from '../../services/api/src/app.ts';
import { createApiServer } from '../../services/api/src/server.ts';
import { LiveStore } from '../../services/api/src/live-store.ts';
import { KitFreeTransactionAdapter } from '../../services/api/src/transaction.ts';
import { createWebServer } from '../../scripts/serve-web.mjs';
import { ANTE_UP_PROGRAM_ADDRESS, findMarketPda, findRecordPda,
  getOpenFreeInstructionDataDecoder } from '../../clients/chain/dist/index.js';

const requireKit = createRequire(new URL('../../clients/chain/package.json', import.meta.url));
const { address, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionEncoder } = requireKit('@solana/kit');
const listen = async server => {
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async server => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
};

// Real F controller, HTTP proxy, D API, Ed25519 authentication and transaction
// signatures. ONLY chain receipts/state are injected; no Solana program runs.
test('F -> web proxy -> D session/prepare -> signed receipt -> open/close and restart discovery', async () => {
  const dir = await mkdtemp(join(process.cwd(),'.proof-integration-runtime-'));
  let vite, apiServer, webServer, store;
  try {
    const now = 1_800_000_000;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const owner = address(getBase58Decoder().decode(publicKey.export({format:'der',type:'spki'}).subarray(-32)));
    const [marketAddress] = await findMarketPda({marketId:new Uint8Array(32).fill(3)});
    const market = { id:marketAddress,keyword:'test only',aliases:[],phase:'CURVE',dataStatus:'PREPARING',
      epochPhase:null,supported:true,chain:{cluster:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS,address:marketAddress},
      snapshot:null,anchor:null,price:null,capabilities:{openFree:{allowed:true,reason:null},closeFree:{allowed:true,reason:null}} };
    const records = new Map(), receipts = new Map();
    let broadcasts = 0, authSignatures = 0, loseWalletResponse = false;
    const read = {mode:'localnet', async markets(){return [market]}, async market(id){return id===market.id?market:null},
      async records(){return [...records.values()]}, async record(id){return records.get(id)??null},
      async proofs(){return []}, async heldCalculationWallets(){return new Set()} };
    const chain = {async get(signature){return receipts.get(signature)??null},
      async discover(){return [...receipts].map(([signature,receipt])=>({signature,receipt}))} };
    store = new LiveStore(join(dir,'operations.sqlite'));
    const transactions = new KitFreeTransactionAdapter({cluster:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS,read,
      now:()=>now,blockhashes:{async latest(){return {blockhash:'11111111111111111111111111111111',lastValidBlockHeight:999n}}}});
    let app = createApp({mode:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS,read,transactions,liveStore:store,chain,now:()=>now});
    apiServer = createApiServer({handle:request=>app.handle(request)});
    const apiOrigin = await listen(apiServer);
    await writeFile(join(dir,'index.html'),'<main>Integration test only</main>');
    webServer = await createWebServer({dist:dir,apiOrigin});
    const webOrigin = await listen(webServer);
    vite = await createVite({root:fileURLToPath(new URL('../../apps/web',import.meta.url)),
      optimizeDeps:{noDiscovery:true},server:{middlewareMode:true,hmr:false},appType:'custom'});
    const {createLiveFreeFlow} = await vite.ssrLoadModule('/src/liveFree.ts');
    const signer = {address:owner, async signAndSendTransactions(list) {
      assert.equal(list.length,1); broadcasts++;
      const tx = list[0], message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
      const signatureBytes = sign(null,Buffer.from(tx.messageBytes),privateKey);
      const signature = getBase58Decoder().decode(signatureBytes);
      receipts.set(signature,{status:'finalized',wireBase64:Buffer.from(getTransactionEncoder().encode({
        ...tx,signatures:{...tx.signatures,[owner]:signatureBytes}})).toString('base64')});
      const instruction = message.instructions[0];
      if (broadcasts === 2) {
        const recordId = message.staticAccounts[instruction.accountIndices[1]];
        const record = records.get(recordId); assert.ok(record);
        records.set(recordId,{...record,status:'CLOSED_NA',exit:{...record.entry,signature,executedAt:now+1,slot:'2'},
          result:{kind:'na',reason:'DATA_NOT_READY'}});
      } else {
        const nonce = getOpenFreeInstructionDataDecoder().decode(instruction.data).recordId;
        const [id] = await findRecordPda({market:marketAddress,owner,recordId:nonce});
        records.set(id,{id,wallet:owner,marketId:marketAddress,direction:'up',status:'OPEN',finality:'finalized',proofId:null,
          entry:{executedAt:now,slot:'1',signature,snapshot:null,h:null,unavailableReason:'DATA_NOT_READY'},exit:null,result:null});
      }
      if (loseWalletResponse) throw new Error('Injected wallet response loss after broadcast');
      return [signatureBytes];
    }};
    const wallet = {address:owner,cluster:'localnet',signer,supportedTransactionVersions:new Set([0,'legacy'])};
    const flow = createLiveFreeFlow({baseUrl:`${webOrigin}/api`,getWallet:()=>wallet,canSignMessage:()=>true,
      async signMessage(bytes){authSignatures++;return sign(null,Buffer.from(bytes),privateKey)},
      nowSeconds:()=>now,requestId:()=>randomUUID(),wait:async()=>{},pollAttempts:2});
    const open = await flow.run({market,action:'openFree',recordId:null});
    assert.equal(open.state,'FINALIZED',JSON.stringify(open));
    const recordId = [...records.keys()][0];
    const openedProfile = await (await fetch(`${webOrigin}/api/v1/profiles/${owner}`)).json();
    assert.equal(openedProfile.data.openRecords[0].id,recordId);
    assert.equal(flow.observeProfile(market.id,wallet,openedProfile.data),true,
      'Finality alone must not unlock another action before the API projection is observed');
    const closed = await flow.run({market,action:'closeFree',recordId});
    assert.equal(closed.state,'FINALIZED',JSON.stringify(closed));
    assert.equal(authSignatures,1,'Bearer session should cover both operations and their polling');
    const profile = await (await fetch(`${webOrigin}/api/v1/profiles/${owner}`)).json();
    assert.equal(profile.data.closedNaCount,'1');
    assert.equal(profile.data.closedValidCount,'0','No invented return while data is preparing');
    assert.equal(profile.data.openRecords.length,0);
    assert.equal(flow.observeProfile(market.id,wallet,profile.data),true,
      'Observe the finalized close projection before opening a new selection');

    loseWalletResponse = true;
    const pending = await flow.run({market,action:'openFree',recordId:null});
    assert.equal(pending.state,'UNKNOWN'); assert.equal(pending.signature,null);
    assert.equal((await flow.run({market,action:'openFree',recordId:null})).requestId,pending.requestId);
    assert.equal(broadcasts,3,'Unknown submission must not broadcast a replacement');
    store.close(); store = new LiveStore(join(dir,'operations.sqlite'));
    app = createApp({mode:'localnet',programId:ANTE_UP_PROGRAM_ADDRESS,read,transactions,liveStore:store,chain,now:()=>now});
    market.capabilities.openFree.allowed = false;
    const recovered = await flow.recheck({market,action:'openFree',recordId:null},pending.requestId,null);
    assert.equal(recovered.state,'FINALIZED',JSON.stringify(recovered));
    assert.ok(recovered.signature); assert.equal(broadcasts,3);
  } finally {
    await close(webServer); await close(apiServer); if(vite) await vite.close(); if(store) store.close();
    await rm(dir,{recursive:true,force:true});
  }
});
