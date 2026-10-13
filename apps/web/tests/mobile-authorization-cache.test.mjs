import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
const server = await createServer({optimizeDeps:{noDiscovery:true},server:{middlewareMode:true,hmr:false},appType:'custom'});
after(()=>server.close());
const {chainScopedAuthorizationCache}=await server.ssrLoadModule('/src/mobileAuthorizationCache.ts');

test('MWA cannot silently reuse another chain authorization on reconnect',async()=>{
  let value={chain:'solana:mainnet',auth_token:'private'};let clears=0;
  const cache=chainScopedAuthorizationCache({get:async()=>value,set:async next=>{value=next},clear:async()=>{value=undefined;clears++}},'solana:devnet');
  assert.equal(await cache.get(),undefined);assert.equal(clears,1);
  const devnet={chain:'solana:devnet',auth_token:'private-devnet'};
  await cache.set(devnet);assert.equal(await cache.get(),devnet);
  await cache.set({chain:'solana:mainnet'});assert.equal(await cache.get(),undefined);
  value={auth_token:'legacy-no-chain'};assert.equal(await cache.get(),undefined);
  await cache.set(devnet);await cache.clear();assert.equal(value,undefined);
});
