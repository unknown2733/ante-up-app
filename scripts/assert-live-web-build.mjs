import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const required = {
  VITE_API_BASE_URL: '/api',
  VITE_ALLOW_FIXTURE_API: 'false',
  VITE_WALLET_CLUSTER: 'devnet',
  VITE_SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  VITE_MWA_APP_URI: 'https://ante-up.fun',
};
for (const [name, expected] of Object.entries(required)) {
  if (process.env[name] !== expected) throw Error(`Live web build requires ${name}=${expected}.`);
}
const dist = resolve('apps/web/dist');
const html = await readFile(resolve(dist, 'index.html'), 'utf8');
const scripts = (await readdir(resolve(dist, 'assets'))).filter(file => /^index-[\w-]+\.js$/.test(file));
if (scripts.length !== 1 || !html.includes(`/assets/${scripts[0]}`)) throw Error('Live web bundle entry is missing or ambiguous.');
const bundle = await readFile(resolve(dist, 'assets', scripts[0]), 'utf8');
if (!bundle.includes('/api') || !bundle.includes(required.VITE_SOLANA_RPC_URL)) {
  throw Error('Live web bundle is missing its API or Devnet transaction verifier.');
}
console.log('Live web API and Devnet transaction configuration verified.');
