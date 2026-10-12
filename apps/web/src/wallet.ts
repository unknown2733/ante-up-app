export const DEMO_WALLET = 'demo:you';

export interface WalletAdapter {
  readonly kind: 'fixture' | 'unavailable';
  readonly canSign: boolean;
  connect(): Promise<string | null>;
  disconnect(): Promise<void>;
}

export const fixtureWallet: WalletAdapter = {
  kind: 'fixture',
  canSign: false,
  async connect() { return DEMO_WALLET; },
  async disconnect() {},
};

// Live signing is intentionally a separate adapter boundary. No browser wallet
// or Seeker capability is implied by the fixture wallet.
export const unavailableWallet: WalletAdapter = {
  kind: 'unavailable',
  canSign: false,
  async connect() { return null; },
  async disconnect() {},
};
