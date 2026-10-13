import { useState } from 'react';
import { createClient } from '@solana/kit';
import { walletSigner } from '@solana/kit-plugin-wallet';
import { useConnect, useConnectedWallet, useDisconnect, useWalletStatus, useWallets } from '@solana/kit-plugin-wallet/react';
import { registerMwa, createDefaultAuthorizationCache, createDefaultChainSelector } from '@solana-mobile/wallet-standard-mobile';
import type { Cluster, WalletContext } from './transactionBoundary';
import { walletDisplayError } from './walletErrors';
import { chainScopedAuthorizationCache } from './mobileAuthorizationCache';

export const walletCluster: Cluster = import.meta.env.VITE_WALLET_CLUSTER === 'localnet' ? 'localnet' : 'devnet';
const appUri = import.meta.env.VITE_MWA_APP_URI || (typeof location !== 'undefined' && location.protocol === 'https:' ? location.origin : '');
if (import.meta.env.VITE_API_BASE_URL && typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent) && appUri && /^https:\/\//.test(appUri)) {
  registerMwa({
    appIdentity: { name: 'Ante Up', uri: appUri },
    chains: [`solana:${walletCluster}`],
    authorizationCache: chainScopedAuthorizationCache(createDefaultAuthorizationCache(), `solana:${walletCluster}`),
    chainSelector: createDefaultChainSelector(),
    onWalletNotFound: async () => { /* Keep the user on this page; show connection error below. */ },
  });
}

export const walletClient = createClient().use(walletSigner({ chain: `solana:${walletCluster}`, storageKey: `ante-up-wallet-${walletCluster}`, autoConnect: !!import.meta.env.VITE_API_BASE_URL, storage: import.meta.env.VITE_API_BASE_URL ? undefined : null }));

export function currentWalletContext(): WalletContext | null {
  const connected = walletClient.wallet.getState().connected;
  if (!connected) return null;
  return {
    address: connected.account.address,
    cluster: walletCluster,
    supportedTransactionVersions: connected.supportedTransactionVersions,
    signer: connected.signer && 'signAndSendTransactions' in connected.signer ? connected.signer : null,
  };
}

export function canSignAuthMessage(wallet: WalletContext): boolean {
  const connected = walletClient.wallet.getState().connected;
  return !!connected && connected.account.address === wallet.address && connected.signer === wallet.signer && connected.account.features.includes('solana:signMessage');
}

export async function signAuthMessage(bytes: Uint8Array, wallet: WalletContext): Promise<Uint8Array> {
  if (!canSignAuthMessage(wallet)) throw new Error('This wallet cannot sign an API authentication message.');
  return new Uint8Array(await walletClient.wallet.signMessage(bytes));
}

export function WalletPanel() {
  const wallets = useWallets(walletClient);
  const connected = useConnectedWallet(walletClient);
  const status = useWalletStatus(walletClient);
  const connect = useConnect(walletClient);
  const disconnect = useDisconnect(walletClient);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const busy = connect.isRunning || disconnect.isRunning;
  return <div className="wallet-panel">
    <button type="button" className="wallet-pill" aria-expanded={open} onClick={() => setOpen(!open)}><span className="wallet-dot" />{connected ? `${connected.account.address.slice(0, 4)}…${connected.account.address.slice(-4)}` : status === 'pending' || status === 'reconnecting' ? 'Checking wallet…' : 'Connect wallet'}</button>
    {open && <div className="wallet-menu"><strong>Solana {walletCluster}</strong>
      {connected ? <><p>{connected.wallet.name} · {connected.account.address.slice(0, 8)}…</p><button disabled={busy} onClick={async () => { setError(''); try { await disconnect.dispatchAsync(); } catch (cause) { setError(walletDisplayError(cause, 'Could not disconnect wallet.')); } }}>Disconnect</button></> : wallets.length ? wallets.map((wallet) => <button key={wallet.name} disabled={busy} onClick={async () => { setError(''); try { await connect.dispatchAsync(wallet); setOpen(false); } catch (cause) { setError(walletDisplayError(cause, 'Could not connect wallet.')); } }}>Connect {wallet.name}</button>) : <p>No compatible wallet found for this network. On Android, use HTTPS and an MWA-compatible wallet.</p>}
      {error && <p role="alert">{error}</p>}
      <small>Connecting alone does not submit a trade.</small>
    </div>}
  </div>;
}

export function WalletProfile({ children }: { children: (address: string | null) => React.ReactNode }) {
  const connected = useConnectedWallet(walletClient);
  return <>{children(connected?.account.address ?? null)}</>;
}
