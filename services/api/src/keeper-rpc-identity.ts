import {createSolanaRpc, isAddress} from '@solana/kit';

/** Bind an operator-selected localnet/devnet scope to the actual RPC network before any send. */
export async function verifyKeeperRpcIdentity(input:{cluster:'localnet'|'devnet';endpoint:string;
  expectedGenesisHash:string;rpc?:{getGenesisHash():{send():Promise<string>}}}):Promise<void> {
  if (!isAddress(input.expectedGenesisHash)) throw new Error('KEEPER_EXPECTED_GENESIS_HASH_REQUIRED');
  let url:URL;
  try {url=new URL(input.endpoint);} catch {throw new Error('KEEPER_RPC_URL_INVALID');}
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('KEEPER_RPC_URL_INVALID');
  if (input.cluster==='localnet' && !['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname))
    throw new Error('KEEPER_LOCALNET_RPC_MUST_BE_LOOPBACK');
  const rpc=input.rpc??createSolanaRpc(input.endpoint);
  if (await rpc.getGenesisHash().send()!==input.expectedGenesisHash) throw new Error('KEEPER_GENESIS_MISMATCH');
}
