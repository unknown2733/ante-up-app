import { createPublicKey, randomUUID, verify } from 'node:crypto';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function decodeBase58(value: string): Uint8Array {
  let n = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error('INVALID_INPUT');
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const char of value) { if (char !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

export interface SignatureVerifier { verify(wallet: string, message: string, signatureBase64: string): Promise<boolean> }
export class Ed25519Verifier implements SignatureVerifier {
  async verify(wallet: string, message: string, signatureBase64: string): Promise<boolean> {
    try {
      const raw = decodeBase58(wallet);
      if (raw.length !== 32) return false;
      const signature = Buffer.from(signatureBase64, 'base64');
      if (signature.length !== 64) return false;
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw)]), format: 'der', type: 'spki' });
      return verify(null, Buffer.from(message, 'utf8'), key, signature);
    } catch { return false; }
  }
}

interface Challenge { wallet: string; cluster: 'localnet' | 'devnet'; nonce: string; expiresAt: number; used: boolean }
export class ChallengeStore {
  private challenges = new Map<string, Challenge>();
  private verifier: SignatureVerifier;
  constructor(verifier: SignatureVerifier = new Ed25519Verifier()) { this.verifier = verifier; }
  issue(wallet: string, cluster: 'localnet' | 'devnet', now: number): { nonce: string; expiresAt: number; message: string } {
    if (decodeBase58(wallet).length !== 32) throw new Error('INVALID_INPUT');
    const nonce = randomUUID();
    const expiresAt = now + 300;
    this.challenges.set(nonce, { wallet, cluster, nonce, expiresAt, used: false });
    return { nonce, expiresAt, message: this.message({ wallet, cluster, nonce, expiresAt, used: false }) };
  }
  private message(c: Challenge): string { return `Ante Up API v1\ncluster:${c.cluster}\nwallet:${c.wallet}\nnonce:${c.nonce}\nexpiresAt:${c.expiresAt}`; }
  async consume(wallet: string, nonce: string, signature: string, now: number, cluster?: 'localnet' | 'devnet'): Promise<boolean> {
    const c = this.challenges.get(nonce);
    if (!c || c.wallet !== wallet || c.used || now > c.expiresAt || (cluster && c.cluster !== cluster)) return false;
    const valid = await this.verifier.verify(wallet, this.message(c), signature);
    if (valid) c.used = true;
    return valid;
  }
}
