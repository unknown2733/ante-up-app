import type { Mode } from '../../../contracts/types';
import type { MarketApi } from './model';
import { fixtureApi } from './fixture';
import { createHttpApi } from './http';
import { createLiveFreeFlow } from './liveFree';
import { createLiveFinancialFlow } from './liveFinancial';
import { createFinancialInstructionVerifier } from './financialInstructionVerifier';
import { createKitChainTransport } from '@ante-up/chain-client';
import { canSignAuthMessage, currentWalletContext, signAuthMessage, walletClient } from './walletSdk';
import { createApiClock } from './apiClock';
import { createLiveConsumerHttp } from './consumerHttp';
import { createVisitorSolFlow } from './visitorSol';
import { referenceConsumerReadApi } from './reference/referenceData';
import { createObservedReferenceReadApi } from './reference/observedReference';

const baseUrl = import.meta.env.VITE_API_BASE_URL;
export const liveConsumerHttp = baseUrl ? createLiveConsumerHttp(baseUrl) : null;
export const referenceReadApi = baseUrl ? createObservedReferenceReadApi(baseUrl) : referenceConsumerReadApi;
let observedMode: Mode | null = baseUrl ? null : 'fixture';
export function transportMode() { return observedMode; }
export const isFixture = !baseUrl;
export const apiClock = createApiClock();
const clockOptions = {nowSeconds:apiClock.nowSeconds,onServerTime:apiClock.observe};
export const liveFreeFlow = baseUrl ? createLiveFreeFlow({ baseUrl, ...clockOptions, getWallet: currentWalletContext, canSignMessage: canSignAuthMessage, signMessage: signAuthMessage }) : null;
const rpcUrl = import.meta.env.VITE_SOLANA_RPC_URL;
export const liveFinancialFlow = baseUrl && liveFreeFlow ? createLiveFinancialFlow({ baseUrl, ...clockOptions, getWallet: currentWalletContext, authorize: liveFreeFlow.authorize, verifyInstruction: rpcUrl ? createFinancialInstructionVerifier(createKitChainTransport(rpcUrl), apiClock.nowSeconds) : undefined }) : null;
export const visitorSolFlow = baseUrl && liveFreeFlow ? createVisitorSolFlow({baseUrl, getWallet: currentWalletContext, authorize: liveFreeFlow.authorize}) : null;
if (liveFreeFlow) {
  let connected = walletClient.wallet.getState().connected;
  walletClient.wallet.subscribe(() => {
    const next = walletClient.wallet.getState().connected;
    if (next?.account.address !== connected?.account.address || next?.signer !== connected?.signer) liveFreeFlow.clearSession();
    connected = next;
  });
}
export const api: MarketApi = baseUrl
  ? createHttpApi(baseUrl, {
    allowFixture: import.meta.env.VITE_ALLOW_FIXTURE_API === 'true',
    onMode(mode) { observedMode = mode; window.dispatchEvent(new Event('ante-up-mode')); },
  })
  : fixtureApi;
