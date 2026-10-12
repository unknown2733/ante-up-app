import { useEffect, useState } from 'react';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import type { Action, MarketView } from '../../../contracts/types';
import type { FinancialAction, FinancialIntent, FinancialPortfolio, FinancialQuote, FinancialVault } from '../../../contracts/financial';
import { apiClock, isFixture, liveFinancialFlow } from './api';
import { currentWalletContext, walletClient, walletCluster } from './walletSdk';
import type { FinancialOutcome, FinancialProgress } from './liveFinancial';
import { displayConsumerError } from './consumer-ui/copy';

function atomAmount(input: string): string {
  const value = input.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)) throw new Error('Enter a positive amount with up to six decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const atoms = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (atoms <= 0n) throw new Error('Amount must be greater than zero.');
  return atoms.toString();
}
function amount(value: string | null | undefined) {
  if (value == null || !/^(0|[1-9][0-9]*)$/.test(value)) return '—';
  const whole = BigInt(value) / 1_000_000n;
  const fraction = (BigInt(value) % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
}
const date = (seconds: number | null) => seconds === null ? '—' : new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(seconds * 1000) + ' UTC';
const actionLabel: Record<FinancialAction, string> = { faucet: 'Get test tUSD', registerMarket: 'Register market', curveBuy: 'Buy on curve', curveSell: 'Sell on curve', graduate: 'Graduate', spotBuy: 'Buy spot', spotSell: 'Sell spot', openPro: 'Open Pro', closePro: 'Close Pro', claim: 'Claim payout', depositLP: 'Deposit liquidity', withdrawLP: 'Withdraw liquidity' };
const financialActions: FinancialAction[] = ['curveBuy', 'curveSell', 'spotBuy', 'spotSell', 'openPro', 'closePro', 'claim', 'depositLP', 'withdrawLP'];
const moneyActions = new Set<FinancialAction>(['curveBuy', 'curveSell', 'spotBuy', 'spotSell']);
const lpActions = new Set<FinancialAction>(['depositLP', 'withdrawLP']);
const proActions = new Set<FinancialAction>(['openPro', 'closePro', 'claim']);
const textError = (error: unknown) => displayConsumerError(error instanceof Error ? error.message : null);

function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) { return <div className={`notice ${error ? 'notice-red' : 'notice-orange'}`}>{children}</div>; }
function Fact({ label, children }: { label: string; children: React.ReactNode }) { return <div><span>{label}</span><strong>{children}</strong></div>; }

function useQuoteRemaining(quote: FinancialQuote | null) {
  const [now, setNow] = useState(() => apiClock.nowSeconds());
  useEffect(() => {
    if (!quote) return;
    const update = () => {
      const value = apiClock.nowSeconds(); setNow(value);
      if (value >= quote.expiresAt) window.clearInterval(timer);
    };
    const timer = window.setInterval(update, 1000);
    update(); window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, [quote?.id, quote?.expiresAt]);
  return quote ? Math.max(0, quote.expiresAt - Math.max(now, apiClock.nowSeconds())) : 0;
}
function QuoteExpiry({ remaining }: { remaining: number }) {
  return <p className="tiny muted">{remaining > 0 ? `Quote expires in ${remaining}s` : 'Quote expired. Get a new quote before signing.'}</p>;
}

export function PrivateFinancialPanel({ wallet, refresh }: { wallet: string; refresh: number }) {
  const [portfolio, setPortfolio] = useState<FinancialPortfolio | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setPortfolio(null); setError(''); }, [wallet]);
  useEffect(() => { if (portfolio) void load(); /* Reload only after a confirmed transaction. */ }, [refresh]);
  async function load() {
    if (!liveFinancialFlow || isFixture) return;
    setLoading(true); setError('');
    try { setPortfolio(await liveFinancialFlow.portfolio()); } catch (cause) { setError(textError(cause)); }
    finally { setLoading(false); }
  }
  return <section className="detail-panel finance-panel"><span className="eyebrow orange-text">PRIVATE FINANCE</span><h2>My test assets</h2><p>Only the connected wallet can view these balances. They do not appear on public free-call profiles.</p>
    {isFixture || !liveFinancialFlow ? <Notice>Financial account lookup is unavailable.</Notice> : <button className="button button-dark" disabled={loading} onClick={() => void load()}>{loading ? 'Loading…' : portfolio ? 'Refresh balances' : 'View balances'}</button>}
    {error && <Notice error>{error}</Notice>}
    {portfolio && <><div className="finance-facts"><Fact label="Test tUSD balance">{amount(portfolio.quoteBalanceAtoms)} tUSD</Fact><Fact label="Market tokens">{portfolio.tokenBalances.length} types</Fact><Fact label="Pro positions">{portfolio.positions.length}</Fact><Fact label="Liquidity shares">{portfolio.lpShares.length} markets</Fact></div><div className="finance-holdings">
      {portfolio.tokenBalances.map((item) => <div key={item.marketId}>Token · {item.marketId}<strong>{amount(item.atoms)}</strong></div>)}
      {portfolio.positions.map((item) => <div key={item.id}>Pro {item.direction === 'long' ? 'Long' : 'Short'} · {item.marketId} · {item.status}<strong>Collateral {amount(item.collateralAtoms)} tUSD</strong></div>)}
      {portfolio.claims.map((item) => <div key={item.id}>Claim {item.id} · {item.status}<strong>{amount(item.payoutAtoms)} + refund {amount(item.refundAtoms)} tUSD</strong></div>)}
      {portfolio.lpShares.map((item) => <div key={item.marketId}>LP · {item.marketId}<strong>{amount(item.sharesAtoms)} shares · withdrawable {amount(item.withdrawableAtoms)}</strong></div>)}
    </div></>}
  </section>;
}

export function FinancialMarket({ market, section, onFinalized }: { market: MarketView; section: 'money' | 'pro' | 'lp'; onFinalized: () => void }) {
  const connected = useConnectedWallet(walletClient);
  const wallet = currentWalletContext();
  const actions = financialActions.filter((action) => section === 'money' ? moneyActions.has(action) : section === 'pro' ? proActions.has(action) : lpActions.has(action));
  const [action, setAction] = useState<FinancialAction>(actions[0]);
  const [quantity, setQuantity] = useState('');
  const [direction, setDirection] = useState<'long' | 'short'>('long');
  const [leverage, setLeverage] = useState('1');
  const [positionId, setPositionId] = useState('');
  const [claimId, setClaimId] = useState('');
  const [portfolio, setPortfolio] = useState<FinancialPortfolio | null>(null);
  const [vault, setVault] = useState<FinancialVault | null>(null);
  const [quote, setQuote] = useState<FinancialQuote | null>(null);
  const quoteRemaining = useQuoteRemaining(quote);
  const [outcome, setOutcome] = useState<FinancialOutcome | null>(null);
  const [progress, setProgress] = useState<FinancialProgress | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = wallet && liveFinancialFlow?.pending(wallet);
  useEffect(() => { setQuote(null); setPortfolio(null); setVault(null); setOutcome(null); setError(''); }, [connected?.account.address, market.id, section]);
  useEffect(() => { setQuote(null); setOutcome(null); setError(''); }, [action, quantity, direction, leverage, positionId, claimId]);
  const modeProblem = isFixture || !liveFinancialFlow ? 'Financial actions are unavailable.' : !wallet ? 'Connect a wallet.' : wallet.cluster !== walletCluster || market.chain?.cluster !== wallet.cluster || market.chain.address !== market.id ? 'Wallet network does not match this market.' : null;
  const capability = market.capabilities[action as Action];
  const unavailable = modeProblem ?? (capability?.allowed !== true ? `${actionLabel[action]} unavailable: ${displayConsumerError(capability?.reason, 'Execution unavailable')}` : null);
  const activePosition = portfolio?.positions.filter((item) => item.marketId === market.id && item.owner === wallet?.address && item.status === 'OPEN') ?? [];
  const unpaidClaims = portfolio?.claims.filter((item) => item.marketId === market.id && item.owner === wallet?.address && item.status === 'UNPAID') ?? [];
  const shares = portfolio?.lpShares.find((item) => item.marketId === market.id);

  async function loadPrivate() {
    if (!liveFinancialFlow || !wallet) return;
    setBusy(true); setError('');
    try { const [mine, aggregate] = await Promise.all([liveFinancialFlow.portfolio(), section === 'lp' ? liveFinancialFlow.vault(market.id) : Promise.resolve(null)]); setPortfolio(mine); setVault(aggregate); }
    catch (cause) { setError(textError(cause)); }
    finally { setBusy(false); }
  }
  async function getQuote() {
    if (!liveFinancialFlow || unavailable || busy || pending) return;
    setBusy(true); setError(''); setProgress('QUOTING'); setQuote(null);
    try {
      const fields: Omit<FinancialIntent, 'requestId' | 'wallet'> = { action, marketId: market.id };
      if (['curveBuy', 'curveSell', 'spotBuy', 'spotSell', 'depositLP', 'withdrawLP'].includes(action)) fields.quantityAtoms = atomAmount(quantity);
      if (action === 'openPro') { fields.collateralAtoms = atomAmount(quantity); fields.leverageBps = String(Number(leverage) * 10000); fields.direction = direction; }
      if (action === 'closePro') { if (!activePosition.some((item) => item.id === positionId)) throw new Error('Select one of your open positions.'); fields.positionId = positionId; }
      if (action === 'claim') { if (!unpaidClaims.some((item) => item.id === claimId)) throw new Error('Select an unpaid claim.'); fields.claimId = claimId; }
      if (action === 'withdrawLP' && (!shares || BigInt(fields.quantityAtoms!) > BigInt(shares.sharesAtoms))) throw new Error('Enter no more than your available liquidity shares.');
      const result = await liveFinancialFlow.quote(fields);
      if (result.kind === 'notExecutable') setError(displayConsumerError(result.reason));
      else setQuote(result.quote);
    } catch (cause) { setError(textError(cause)); }
    finally { setBusy(false); setProgress(null); }
  }
  async function execute() {
    if (!liveFinancialFlow || !quote || busy) return;
    setBusy(true); setError('');
    try {
      const result = await liveFinancialFlow.execute(quote, setProgress);
      setOutcome(result); setQuote(null);
      if (result.state === 'FINALIZED') { onFinalized(); await loadPrivate(); }
    } catch (cause) { setError(textError(cause)); }
    finally { setBusy(false); setProgress(null); }
  }
  async function recheck() {
    if (!liveFinancialFlow || busy) return;
    setBusy(true); setError('');
    try { const result = await liveFinancialFlow.recheck(); setOutcome(result); if (result.state === 'FINALIZED') { onFinalized(); await loadPrivate(); } }
    catch (cause) { setError(textError(cause)); }
    finally { setBusy(false); }
  }

  return <section className="detail-panel finance-panel"><span className="eyebrow orange-text">{section === 'money' ? 'TRADING' : section === 'pro' ? 'PRO' : 'LIQUIDITY'}</span><h2>{section === 'money' ? 'Curve and spot trading' : section === 'pro' ? 'Pro positions and settlement' : 'Liquidity deposits and withdrawals'}</h2>
    <p>Trades use test tUSD. Display prices and quotes do not guarantee execution; market state, available capital, balance, and time window are checked again when you sign.</p>
    <div className="finance-tabs">{actions.map((item) => <button key={item} type="button" className={action === item ? 'active' : ''} onClick={() => setAction(item)}>{actionLabel[item]}</button>)}</div>
    {section !== 'money' && <button className="button button-dark" disabled={busy || !!modeProblem} onClick={() => void loadPrivate()}>{portfolio ? 'Refresh my positions and balances' : 'View my positions and balances'}</button>}
    {section === 'lp' && vault && <div className="finance-facts"><Fact label="Available capital">{amount(vault.freeCapitalAtoms)} tUSD</Fact><Fact label="Vault NAV">{amount(vault.navAtoms)} tUSD</Fact><Fact label="Settlement stage">{vault.epochPhase ?? 'Unavailable'}</Fact><Fact label="My withdrawable amount">{amount(shares?.withdrawableAtoms)}</Fact></div>}
    <div className="finance-form">
      {['curveBuy', 'curveSell', 'spotBuy', 'spotSell', 'openPro', 'depositLP', 'withdrawLP'].includes(action) && <label>{action === 'openPro' ? 'Collateral (tUSD)' : action === 'depositLP' ? 'Deposit (tUSD)' : action === 'withdrawLP' ? 'Shares to withdraw' : 'Market token amount'}<input inputMode="decimal" placeholder="0.000000" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>}
      {action === 'openPro' && <><label>Direction<select value={direction} onChange={(event) => setDirection(event.target.value as 'long' | 'short')}><option value="long">Long</option><option value="short">Short</option></select></label><label>Leverage<select value={leverage} onChange={(event) => setLeverage(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label></>}
      {action === 'closePro' && <label>My open position<select value={positionId} onChange={(event) => setPositionId(event.target.value)}><option value="">Select one</option>{activePosition.map((item) => <option key={item.id} value={item.id}>{item.direction === 'long' ? 'Long' : 'Short'} · {item.id} · Collateral {amount(item.collateralAtoms)} tUSD</option>)}</select></label>}
      {action === 'claim' && <label>My unpaid claim<select value={claimId} onChange={(event) => setClaimId(event.target.value)}><option value="">Select one</option>{unpaidClaims.map((item) => <option key={item.id} value={item.id}>{item.id} · Payout {amount(item.payoutAtoms)} + refund {amount(item.refundAtoms)} tUSD</option>)}</select></label>}
    </div>
    {unavailable && <Notice>{unavailable}</Notice>}
    {pending && <Notice>This wallet has an unresolved request. Check it before sending another. Request ID: {pending.requestId}{pending.signature && ` · Signature: ${pending.signature}`}</Notice>}
    {error && <Notice error>{error}</Notice>}
    {outcome && <Notice error={outcome.state === 'FAILED'}>{outcome.state === 'FINALIZED' ? 'Finalized on chain. Your account has been refreshed.' : outcome.reason ? displayConsumerError(outcome.reason) : `Request status: ${outcome.state}`} · Request ID: {outcome.requestId}{outcome.signature && ` · Signature: ${outcome.signature}`}</Notice>}
    {pending && <button className="button button-dark full" disabled={busy || !connected} onClick={() => void recheck()}>Check existing request</button>}
    {!quote && <button className="button button-blue full" disabled={busy || !!unavailable || !!pending} onClick={() => void getQuote()}>{busy && progress === 'QUOTING' ? 'Getting quote…' : `${actionLabel[action]} · review quote`}</button>}
    {quote && <div className="finance-quote">{!busy && <QuoteExpiry remaining={quoteRemaining} />}<h3>Review quote before signing</h3><div className="finance-facts"><Fact label="Market · stage">{market.keyword} · {quote.phase ?? 'N/A'}</Fact><Fact label="Price">{amount(quote.priceAtoms)} tUSD</Fact><Fact label="Gross amount">{amount(quote.grossAtoms)} tUSD</Fact><Fact label="Trading fee">{amount(quote.tradeFeeAtoms)} tUSD</Fact><Fact label="Prepaid time cost">{amount(quote.timePrepaidAtoms)} tUSD</Fact><Fact label="Maximum payment">{amount(quote.maxPaymentAtoms)} tUSD</Fact><Fact label="Minimum received">{amount(quote.minReceiveAtoms)}</Fact><Fact label="Maximum payout reserve">{amount(quote.maxPayoutAtoms)} tUSD</Fact><Fact label="Maturity">{date(quote.maturityAt)}</Fact><Fact label="Quote expiry">{date(quote.expiresAt)}</Fact><Fact label="Config · state version">{quote.configVersion} · {quote.stateVersion}</Fact><Fact label="Snapshot">{quote.snapshot?.sequence ?? 'N/A'}</Fact></div><p>A quote does not reserve capital. Execution checks current state again and may fail or require a new quote.</p>
      {!liveFinancialFlow?.canExecute(action) && <Notice>Signing is unavailable because this action's chain accounts or data verifier is not connected.</Notice>}
      <div className="finance-buttons"><button className="button button-dark" onClick={() => setQuote(null)}>Cancel · new quote</button><button className="button button-blue" disabled={busy || !liveFinancialFlow?.canExecute(action) || quoteRemaining === 0} onClick={() => void execute()}>{busy ? `${progress ?? 'Processing'}…` : 'Review and sign in wallet'}</button></div>
    </div>}
  </section>;
}

export function FinancialFaucet({ onFinalized }: { onFinalized: () => void }) {
  const connected = useConnectedWallet(walletClient);
  const wallet = currentWalletContext();
  const [quote, setQuote] = useState<FinancialQuote | null>(null);
  const quoteRemaining = useQuoteRemaining(quote);
  const [outcome, setOutcome] = useState<FinancialOutcome | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = wallet && liveFinancialFlow?.pending(wallet);
  useEffect(() => { setQuote(null); setOutcome(null); setError(''); }, [connected?.account.address]);
  async function getQuote() {
    if (!liveFinancialFlow) return;
    setBusy(true); setError('');
    try { const result = await liveFinancialFlow.quote({ action: 'faucet', marketId: null }); if (result.kind === 'quote') setQuote(result.quote); else setError(displayConsumerError(result.reason)); }
    catch (cause) { setError(textError(cause)); } finally { setBusy(false); }
  }
  async function execute() {
    if (!liveFinancialFlow || !quote) return;
    setBusy(true); setError('');
    try { const result = await liveFinancialFlow.execute(quote); setOutcome(result); setQuote(null); if (result.state === 'FINALIZED') onFinalized(); }
    catch (cause) { setError(textError(cause)); } finally { setBusy(false); }
  }
  async function recheck() {
    if (!liveFinancialFlow) return;
    setBusy(true); setError('');
    try { const result = await liveFinancialFlow.recheck(); setOutcome(result); if (result.state === 'FINALIZED') onFinalized(); }
    catch (cause) { setError(textError(cause)); } finally { setBusy(false); }
  }
  return <div className="page"><div className="profile-header"><span className="eyebrow orange-text">DEVNET TEST ASSET</span><h1>Get test funds<span className="title-dot">.</span></h1><p>Test tUSD requires a quote and final on-chain confirmation. Devnet SOL for network fees is separate.</p></div><section className="detail-panel finance-panel"><h2>Request test tUSD</h2><p>Availability and retry time follow current server limits. Your balance updates only after signature and final confirmation.</p>
    {isFixture || !liveFinancialFlow ? <Notice>Test tUSD is unavailable.</Notice> : !wallet ? <Notice>Connect a Solana wallet.</Notice> : wallet.cluster !== walletCluster ? <Notice>Wallet network does not match.</Notice> : null}
    {pending && <Notice>Unresolved request ID: {pending.requestId}{pending.signature && ` · Signature: ${pending.signature}`}</Notice>}
    {error && <Notice error>{error}</Notice>}
    {outcome && <Notice error={outcome.state === 'FAILED'}>{outcome.reason ? displayConsumerError(outcome.reason) : outcome.state} · Request ID: {outcome.requestId}</Notice>}
    {pending && <button className="button button-dark full" disabled={busy} onClick={() => void recheck()}>Check existing request</button>}
    {!quote && <button className="button button-blue full" disabled={busy || !wallet || !!pending || !liveFinancialFlow} onClick={() => void getQuote()}>{busy ? 'Checking…' : 'Check eligibility and quote'}</button>}
    {quote && <div className="finance-quote">{!busy && <QuoteExpiry remaining={quoteRemaining} />}<h3>Review payout terms</h3><div className="finance-facts"><Fact label="Expected receipt">{amount(quote.minReceiveAtoms)} tUSD</Fact><Fact label="Quote expiry">{date(quote.expiresAt)}</Fact></div>{!liveFinancialFlow?.canExecute('faucet') && <Notice>Signing is unavailable because the test tUSD instruction verifier is not connected.</Notice>}<div className="finance-buttons"><button className="button button-dark" onClick={() => setQuote(null)}>Cancel</button><button className="button button-blue" disabled={busy || !liveFinancialFlow?.canExecute('faucet') || quoteRemaining === 0} onClick={() => void execute()}>Sign in wallet</button></div></div>}
  </section></div>;
}

export function FinancialRegistration({ onFinalized }: { onFinalized: () => void }) {
  const connected = useConnectedWallet(walletClient);
  const wallet = currentWalletContext();
  const [keyword, setKeyword] = useState('');
  const [aliases, setAliases] = useState('');
  const [quote, setQuote] = useState<FinancialQuote | null>(null);
  const quoteRemaining = useQuoteRemaining(quote);
  const [outcome, setOutcome] = useState<FinancialOutcome | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = wallet && liveFinancialFlow?.pending(wallet);
  useEffect(() => { setQuote(null); setOutcome(null); setError(''); }, [connected?.account.address]);
  async function getQuote() {
    if (!liveFinancialFlow) return;
    setBusy(true); setError('');
    try {
      const normalized = keyword.trim().toLowerCase().replace(/\s+/g, ' ');
      const list = aliases.split(',').map((value) => value.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean);
      const result = await liveFinancialFlow.quote({ action: 'registerMarket', marketId: null, keyword: normalized, aliases: list });
      if (result.kind === 'quote') setQuote(result.quote); else setError(displayConsumerError(result.reason));
    } catch (cause) { setError(textError(cause)); } finally { setBusy(false); }
  }
  async function execute() {
    if (!liveFinancialFlow || !quote) return;
    setBusy(true); setError('');
    try { const result = await liveFinancialFlow.execute(quote); setOutcome(result); setQuote(null); if (result.state === 'FINALIZED') onFinalized(); }
    catch (cause) { setError(textError(cause)); } finally { setBusy(false); }
  }
  async function recheck() {
    if (!liveFinancialFlow) return;
    setBusy(true); setError('');
    try { const result = await liveFinancialFlow.recheck(); setOutcome(result); if (result.state === 'FINALIZED') onFinalized(); }
    catch (cause) { setError(textError(cause)); } finally { setBusy(false); }
  }
  return <div className="page"><div className="profile-header"><span className="eyebrow orange-text">NEW MARKET</span><h1>Register a keyword<span className="title-dot">.</span></h1><p>Register an English keyword and limited aliases. The fee is 10 tUSD plus network fees. Registration does not guarantee data coverage or trading availability.</p></div><section className="detail-panel finance-panel"><h2>Review registration terms</h2>
    <div className="finance-form"><label>English keyword<input value={keyword} placeholder="example keyword" onChange={(event) => { setKeyword(event.target.value); setQuote(null); }} /></label><label>Aliases · comma separated<input value={aliases} placeholder="#examplekeyword" onChange={(event) => { setAliases(event.target.value); setQuote(null); }} /></label></div>
    <p>Aliases may be the keyword, its joined form, or its hashtag. Data support is checked after registration.</p>
    {isFixture || !liveFinancialFlow ? <Notice>Market registration is unavailable.</Notice> : !wallet ? <Notice>Connect a wallet.</Notice> : null}
    {pending && <Notice>Unresolved request ID: {pending.requestId}{pending.signature && ` · Signature: ${pending.signature}`}</Notice>}
    {error && <Notice error>{error}</Notice>}
    {outcome && <Notice error={outcome.state === 'FAILED'}>{outcome.reason ? displayConsumerError(outcome.reason) : outcome.state} · Request ID: {outcome.requestId}</Notice>}
    {pending && <button className="button button-dark full" disabled={busy} onClick={() => void recheck()}>Check existing request</button>}
    {!quote && <button className="button button-blue full" disabled={busy || !wallet || !!pending || !liveFinancialFlow} onClick={() => void getQuote()}>{busy ? 'Checking…' : 'Review registration quote'}</button>}
    {quote && <div className="finance-quote">{!busy && <QuoteExpiry remaining={quoteRemaining} />}<h3>Review registration before signing</h3><div className="finance-facts"><Fact label="Primary keyword">{quote.intent.keyword}</Fact><Fact label="Aliases">{quote.intent.aliases?.join(', ') || 'None'}</Fact><Fact label="Market address">{quote.chain.address}</Fact><Fact label="Maximum payment">{amount(quote.maxPaymentAtoms)} tUSD</Fact><Fact label="Quote expiry">{date(quote.expiresAt)}</Fact></div>{!liveFinancialFlow?.canExecute('registerMarket') && <Notice>Signing is unavailable because registration verification or chain lookup is not connected.</Notice>}<div className="finance-buttons"><button className="button button-dark" onClick={() => setQuote(null)}>Cancel</button><button className="button button-blue" disabled={busy || !liveFinancialFlow?.canExecute('registerMarket') || quoteRemaining === 0} onClick={() => void execute()}>Review and sign in wallet</button></div></div>}
  </section></div>;
}
