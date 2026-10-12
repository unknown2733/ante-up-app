import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { ChallengeStore } from '../src/auth.ts';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`), encoded = '';
  while (n) { encoded = alphabet[Number(n % 58n)] + encoded; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; encoded = '1' + encoded; }
  return encoded;
}

test('Ed25519 wallet challenge binds domain, cluster, wallet, nonce and expiry; nonce is one-use', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const wallet = base58(raw);
  const store = new ChallengeStore();
  const challenge = store.issue(wallet, 'devnet', 1000);
  const signature = sign(null, Buffer.from(challenge.message), privateKey).toString('base64');
  assert.equal(await store.consume(wallet, challenge.nonce, signature, 1001), true);
  assert.equal(await store.consume(wallet, challenge.nonce, signature, 1001), false);
  const next = store.issue(wallet, 'localnet', 1000);
  assert.equal(await store.consume(wallet, next.nonce, signature, 1001), false);
  const expired = store.issue(wallet, 'devnet', 1000);
  const signedExpired = sign(null, Buffer.from(expired.message), privateKey).toString('base64');
  assert.equal(await store.consume(wallet, expired.nonce, signedExpired, 1301), false);
});
