import { useEffect, useRef, useState } from 'react';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import type { Action, MarketView } from '../../../contracts/types';
import type { FinancialAction, FinancialIntent, FinancialPortfolio, FinancialQuote, FinancialVault } from '../../../contracts/financial';
import { apiClock, isFixture, liveFinancialFlow, visitorSolFlow } from './api';
import type { SolReadiness, SolClaim } from './visitorSol';
import { currentWalletContext, walletClient, walletCluster } from './walletSdk';
import type { FinancialOutcome, FinancialProgress } from './liveFinancial';
import { displayConsumerError } from './consumer-ui/copy';
import { marketDisplayTitle } from './consumer-ui/catalog';
import { transactionHref } from './sharing/proofLinks';
import './financialPresentation.css';

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
function solAmount(lamports: string) {
  const value = BigInt(lamports);
  return `${(value / 1_000_000_000n).toString()}.${((value % 1_000_000_000n) / 100_000n).toString().padStart(4, '0')}`;
}
const date = (seconds: number | null) => seconds === null ? '—' : new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(seconds * 1000) + ' UTC';
const actionLabel: Record<FinancialAction, string> = { faucet: 'Get tUSD', registerMarket: 'Register market', curveBuy: 'Buy on curve', curveSell: 'Sell on curve', graduate: 'Graduate', spotBuy: 'Buy spot', spotSell: 'Sell spot', openPro: 'Open Pro', closePro: 'Close Pro', claim: 'Claim payout', depositLP: 'Deposit liquidity', withdrawLP: 'Withdraw liquidity' };
const financialActions: FinancialAction[] = ['curveBuy', 'curveSell', 'spotBuy', 'spotSell', 'openPro', 'closePro', 'claim', 'depositLP', 'withdrawLP'];
const moneyActions = new Set<FinancialAction>(['curveBuy', 'curveSell', 'spotBuy', 'spotSell']);
const lpActions = new Set<FinancialAction>(['depositLP', 'withdrawLP']);
const proActions = new Set<FinancialAction>(['openPro', 'closePro', 'claim']);
const textError = (error: unknown) => displayConsumerError(error instanceof Error ? error.message : null);

function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) { return <div className={`notice ${error ? 'notice-red' : 'notice-orange'}`}>{children}</div>; }
function Fact({ label, children }: { label: string; children: React.ReactNode }) { return <div><span>{label}</span><strong>{children}</strong></div>; }

// Form identity changes invalidate in-flight preparation, including unmount/reconnect.
function useQuoteGeneration(key: string, signer: unknown) {
  const generation = useRef({key, signer, version:0});
  if (generation.current.key !== key || generation.current.signer !== signer) generation.current = {key, signer, version:generation.current.version + 1};
  useEffect(() => () => { generation.current.version++; }, []);
  return generation;
}

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
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); liveFinancialFlow?.cancelReview(quote); };
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
  return <section className="detail-panel finance-panel"><span className="eyebrow orange-text">PRIVATE FINANCE</span><h2>My assets</h2><p>Only the connected wallet can view these balances. They do not appear on public chip profiles.</p>
    {isFixture || !liveFinancialFlow ? <Notice>Financial account lookup is unavailable.</Notice> : <button className="button button-dark" disabled={loading} onClick={() => void load()}>{loading ? 'Loading…' : portfolio ? 'Refresh balances' : 'View balances'}</button>}
    {error && <Notice error>{error}</Notice>}
    {portfolio && <><div className="finance-facts"><Fact label="tUSD balance">{amount(portfolio.quoteBalanceAtoms)} tUSD</Fact><Fact label="Market tokens">{portfolio.tokenBalances.length} types</Fact><Fact label="Pro positions">{portfolio.positions.length}</Fact><Fact label="Liquidity shares">{portfolio.lpShares.length} markets</Fact></div><div className="finance-holdings">
      {portfolio.tokenBalances.map((item) => <div key={item.marketId}>Token · {item.marketId}<strong>{amount(item.atoms)}</strong></div>)}
      {portfolio.positions.map((item) => <div key={item.id}>Pro {item.direction === 'long' ? 'Long' : 'Short'} · {item.marketId} · {item.status}<strong>Collateral {amount(item.collateralAtoms)} tUSD</strong></div>)}
      {portfolio.claims.map((item) => <div key={item.id}>Claim {item.id} · {item.status}<strong>{amount(item.payoutAtoms)} + refund {amount(item.refundAtoms)} tUSD</strong></div>)}
      {portfolio.lpShares.map((item) => <div key={item.marketId}>LP · {item.marketId}<strong>{amount(item.sharesAtoms)} shares · withdrawable {amount(item.withdrawableAtoms)}</strong></div>)}
    </div></>}
  </section>;
}

export function FinancialMarket({ market, section, onFinalized, refreshBlocked = false }: { market: MarketView; section: 'money' | 'pro' | 'lp'; onFinalized: () => void; refreshBlocked?: boolean }) {
  const connected = useConnectedWallet(walletClient);
  const wallet = currentWalletContext();
  const actions = financialActions.filter((action) => section === 'money' ? moneyActions.has(action) && action.startsWith(market.phase === 'INDEXED' ? 'spot' : 'curve') : section === 'pro' ? proActions.has(action) : lpActions.has(action));
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
  const quoteGeneration = useQuoteGeneration(JSON.stringify([connected?.account.address, wallet?.cluster, market.id, section, action, quantity, direction, leverage, positionId, claimId]), wallet?.signer);
  const pending = wallet && liveFinancialFlow?.pending(wallet);
  useEffect(() => { setQuote(null); setPortfolio(null); setVault(null); setOutcome(null); setError(''); }, [connected?.account.address, market.id, section]);
  useEffect(() => { setQuote(null); setOutcome(null); setError(''); }, [action, quantity, direction, leverage, positionId, claimId]);
  const modeProblem = isFixture || !liveFinancialFlow ? 'Financial actions are unavailable.' : !wallet ? 'Connect a wallet.' : wallet.cluster !== walletCluster || market.chain?.cluster !== wallet.cluster || market.chain.address !== market.id ? 'Wallet network does not match this market.' : null;
  const capability = market.capabilities[action as Action];
  const unavailable = refreshBlocked ? 'Refreshing market conditions. Wait for a current quote.' : modeProblem ?? (capability?.allowed !== true ? `${actionLabel[action]} unavailable: ${displayConsumerError(capability?.reason, 'Execution unavailable')}` : null);
  const activePosition = portfolio?.positions.filter((item) => item.marketId === market.id && item.owner === wallet?.address && item.status === 'OPEN') ?? [];
  const unpaidClaims = portfolio?.claims.filter((item) => item.marketId === market.id && item.owner === wallet?.address && item.status === 'UNPAID') ?? [];
  const emptySelection = portfolio?.wallet === wallet?.address && portfolio && !modeProblem && !refreshBlocked && !busy && !error
    ? action === 'claim' && unpaidClaims.length === 0 ? 'No payouts to claim.'
      : action === 'closePro' && activePosition.length === 0 ? 'No open positions to close.' : null
    : null;
  const shares = portfolio?.lpShares.find((item) => item.marketId === market.id);
  const heldTokens = portfolio?.tokenBalances.find(item => item.marketId === market.id);
  const outcomeLink = outcome && (outcome.state === 'FINALIZED' || outcome.state === 'CONFIRMED')
    ? transactionHref(outcome.signature, wallet?.cluster === 'devnet' ? 'devnet' : null) : null;
  useEffect(() => { if (!actions.includes(action)) { setAction(actions[0]); setQuote(null); } }, [market.phase]);

  async function loadPrivate() {
    if (!liveFinancialFlow || !wallet) return;
    setBusy(true); setError('');
    try { const [mine, aggregate] = await Promise.all([liveFinancialFlow.portfolio(), section === 'lp' ? liveFinancialFlow.vault(market.id) : Promise.resolve(null)]); setPortfolio(mine); setVault(aggregate); }
    catch (cause) { setError(textError(cause)); }
    finally { setBusy(false); }
  }
  async function getQuote() {
    if (!liveFinancialFlow || unavailable || busy || pending) return;
    const version = quoteGeneration.current.version;
    const current = () => version === quoteGeneration.current.version;
    setBusy(true); setError(''); setOutcome(null); setProgress('QUOTING'); setQuote(null);
    try {
      const fields: Omit<FinancialIntent, 'requestId' | 'wallet'> = { action, marketId: market.id };
      if (['curveBuy', 'curveSell', 'spotBuy', 'spotSell', 'depositLP', 'withdrawLP'].includes(action)) fields.quantityAtoms = atomAmount(quantity);
      if (action === 'openPro') { fields.collateralAtoms = atomAmount(quantity); fields.leverageBps = String(Number(leverage) * 10000); fields.direction = direction; }
      if (action === 'closePro') { if (!activePosition.some((item) => item.id === positionId)) throw new Error('Select one of your open positions.'); fields.positionId = positionId; }
      if (action === 'claim') { if (!unpaidClaims.some((item) => item.id === claimId)) throw new Error('Select an unpaid claim.'); fields.claimId = claimId; }
      if (action === 'withdrawLP' && (!shares || BigInt(fields.quantityAtoms!) > BigInt(shares.sharesAtoms))) throw new Error('Enter no more than your available liquidity shares.');
      const result = await liveFinancialFlow.quote(fields);
      if (!current()) { if (result.kind === 'quote') liveFinancialFlow.cancelReview(result.quote); return; }
      if (result.kind === 'notExecutable') setError(displayConsumerError(result.reason));
      else { const failure = await liveFinancialFlow.prepareQuote(result.quote, setProgress); if (!current()) { liveFinancialFlow.cancelReview(result.quote); return; } if (failure) setOutcome(failure); else setQuote(result.quote); }
    } catch (cause) { if (current()) setError(textError(cause)); }
    finally { setBusy(false); setProgress(null); }
  }
  async function execute() {
    if (!liveFinancialFlow || !quote || busy || refreshBlocked) return;
    setBusy(true); setError('');
    try {
      const result = await liveFinancialFlow.signReviewed(quote, setProgress);
      setOutcome(result); setQuote(null);
      if (result.state === 'FINALIZED') { onFinalized(); await loadPrivate(); if (quote.intent.action === 'closePro') setAction('claim'); }
    } catch (cause) { setError(textError(cause)); }
    finally { setBusy(false); setProgress(null); }
  }
  async function recheck() {
    if (!liveFinancialFlow || busy) return;
    setBusy(true); setError('');
    try { const result = await liveFinancialFlow.recheck(); setOutcome(result); if (result.state === 'FINALIZED') { onFinalized(); await loadPrivate(); if (pending?.action === 'closePro') setAction('claim'); } }
    catch (cause) { setError(textError(cause)); }
    finally { setBusy(false); }
  }

  return <section className="detail-panel finance-panel"><span className="eyebrow orange-text">{section === 'money' ? 'TRADING' : section === 'pro' ? 'PRO' : 'LIQUIDITY'}</span><h2>{section === 'money' ? 'Buy / Sell' : section === 'pro' ? 'Pro positions' : 'Liquidity'}</h2>
    <p>{section === 'money' ? 'Choose an amount and review your quote.' : section === 'pro' ? 'Manage your long and short positions.' : 'Add liquidity or withdraw your shares.'}</p>
    <details className="au-evidence-details"><summary>Market details</summary><p>Network: Devnet · tUSD test asset. {market.dataProvenance === 'SYNTHETIC_QA' ? 'Price inputs are operator-generated, not measured public attention.' : 'Prices follow the market’s published data.'} Your signed quote sets the transaction terms.</p><p>Market: {market.keyword}</p></details>
    <div className="finance-tabs">{actions.map((item) => <button key={item} type="button" disabled={busy} className={action === item ? 'active' : ''} onClick={() => setAction(item)}>{actionLabel[item]}</button>)}</div>
    <button className="button button-dark" disabled={busy || !!modeProblem} onClick={() => void loadPrivate()}>{portfolio ? 'Refresh my balances' : 'View my balances'}</button>
    {portfolio && <div className="finance-facts" aria-label="Your market balances"><Fact label="Balance">{amount(portfolio.quoteBalanceAtoms)} tUSD</Fact>{section === 'money' && <Fact label="Your market tokens">{amount(heldTokens?.atoms ?? '0')}</Fact>}{section === 'lp' && <Fact label="Your liquidity shares">{amount(shares?.sharesAtoms ?? '0')}</Fact>}</div>}
    {section === 'pro' && action !== 'claim' && !emptySelection && portfolio && <div className="finance-holdings" aria-label="Your open positions">{activePosition.length === 0 ? <p className="tiny muted">No open positions in this market.</p> : activePosition.map(item => <div key={item.id}><strong>{item.direction === 'long' ? 'Long' : 'Short'} · {amount(item.collateralAtoms)} tUSD collateral</strong><span>Entry {amount(item.entryPriceAtoms)} tUSD · Notional {amount(item.notionalAtoms)} tUSD</span><small>Matures {date(item.maturityAt)}</small></div>)}</div>}
    {section === 'lp' && vault && <div className="finance-facts"><Fact label="Available capital">{amount(vault.freeCapitalAtoms)} tUSD</Fact><Fact label="Vault NAV">{amount(vault.navAtoms)} tUSD</Fact><Fact label="Settlement stage">{vault.epochPhase ?? 'Unavailable'}</Fact><Fact label="My withdrawable amount">{amount(shares?.withdrawableAtoms)}</Fact></div>}
    <div className="finance-form">
      {['curveBuy', 'curveSell', 'spotBuy', 'spotSell', 'openPro', 'depositLP', 'withdrawLP'].includes(action) && <label>{action === 'openPro' ? 'Collateral (tUSD)' : action === 'depositLP' ? 'Deposit (tUSD)' : action === 'withdrawLP' ? 'Shares to withdraw' : 'Market token amount'}<input disabled={busy} inputMode="decimal" placeholder="0.000000" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>}
      {action === 'openPro' && <><label>Direction<select disabled={busy} value={direction} onChange={(event) => setDirection(event.target.value as 'long' | 'short')}><option value="long">Long</option><option value="short">Short</option></select></label><label>Leverage<select disabled={busy} value={leverage} onChange={(event) => setLeverage(event.target.value)}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label></>}
      {action === 'closePro' && !emptySelection && <label>My open position<select disabled={busy} value={positionId} onChange={(event) => setPositionId(event.target.value)}><option value="">Select one</option>{activePosition.map((item) => <option key={item.id} value={item.id}>{item.direction === 'long' ? 'Long' : 'Short'} · {item.id} · Collateral {amount(item.collateralAtoms)} tUSD</option>)}</select></label>}
      {action === 'claim' && !emptySelection && <label>My unpaid claim<select disabled={busy} value={claimId} onChange={(event) => setClaimId(event.target.value)}><option value="">Select one</option>{unpaidClaims.map((item) => <option key={item.id} value={item.id}>{item.id} · Payout {amount(item.payoutAtoms)} + refund {amount(item.refundAtoms)} tUSD</option>)}</select></label>}
    </div>
    {emptySelection && <p className="tiny muted" role="status">{emptySelection}</p>}
    {unavailable && !(emptySelection && capability?.reason === 'LIMIT_REACHED') && <Notice>{unavailable}</Notice>}
    {pending && <Notice>This wallet has an unresolved request. Check it before sending another. Request ID: {pending.requestId}{pending.signature && ` · Signature: ${pending.signature}`}</Notice>}
    {error && <Notice error>{error}</Notice>}
    {outcome && <div className="au-finance-outcome" role="status"><Notice error={outcome.state === 'FAILED'}>{outcome.state === 'FINALIZED' ? 'Transaction confirmed.' : outcome.reason ? displayConsumerError(outcome.reason) : `Request status: ${outcome.state}`}{outcomeLink && <p><a href={outcomeLink} target="_blank" rel="noopener noreferrer">View transaction ↗</a></p>}<details><summary>Request details</summary><p>Network: Devnet</p><code>{outcome.requestId}</code>{outcome.signature && <code>{outcome.signature}</code>}</details></Notice></div>}
    {pending && <button className="button button-dark full" disabled={busy || !connected} onClick={() => void recheck()}>Check existing request</button>}
    {!quote && !emptySelection && <button className="button button-blue full" disabled={busy || !!unavailable || !!pending} onClick={() => void getQuote()}>{busy && progress === 'QUOTING' ? 'Getting quote…' : `${actionLabel[action]} · review quote`}</button>}
    {quote && <div className="finance-quote">{!busy && <QuoteExpiry remaining={quoteRemaining} />}<h3>Review quote before signing</h3><div className="finance-facts"><Fact label="Action">{actionLabel[quote.intent.action]}</Fact>{quote.intent.action === 'openPro' && <><Fact label="Direction">{quote.intent.direction === 'long' ? 'Long' : 'Short'}</Fact><Fact label="Leverage">{Number(quote.intent.leverageBps) / 10000}×</Fact></>}<Fact label="Market · stage">{marketDisplayTitle(market.keyword)} · {quote.phase ?? 'N/A'}</Fact><Fact label="Price">{amount(quote.priceAtoms)} tUSD</Fact><Fact label="Gross amount">{amount(quote.grossAtoms)} tUSD</Fact><Fact label="Trading fee">{amount(quote.tradeFeeAtoms)} tUSD</Fact><Fact label="Prepaid time cost">{amount(quote.timePrepaidAtoms)} tUSD</Fact><Fact label="Maximum payment">{amount(quote.maxPaymentAtoms)} tUSD</Fact><Fact label="Minimum received">{amount(quote.minReceiveAtoms)}</Fact><Fact label="Maximum payout reserve">{amount(quote.maxPayoutAtoms)} tUSD</Fact><Fact label="Maturity">{date(quote.maturityAt)}</Fact><Fact label="Quote expiry">{date(quote.expiresAt)}</Fact><Fact label="Config · state version">{quote.configVersion} · {quote.stateVersion}</Fact><Fact label="Snapshot">{quote.snapshot?.sequence ?? 'N/A'}</Fact></div><p>A quote does not reserve capital. Execution checks current state again and may fail or require a new quote.</p>
      {!liveFinancialFlow?.canExecute(action) && <Notice>Signing is unavailable because this action's chain accounts or data verifier is not connected.</Notice>}
      <div className="finance-buttons"><button className="button button-dark" onClick={() => setQuote(null)}>Cancel · new quote</button><button className="button button-blue" disabled={busy || refreshBlocked || !liveFinancialFlow?.canExecute(action) || quoteRemaining === 0} onClick={() => void execute()}>{busy ? `${progress ?? 'Processing'}…` : 'Review and sign in wallet'}</button></div>
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
  const [solReadiness, setSolReadiness] = useState<SolReadiness | null>(null);
  const [solClaim, setSolClaim] = useState<SolClaim | null>(null);
  const [solError, setSolError] = useState('');
  const [solBusy, setSolBusy] = useState(false);
  const [solRefresh, setSolRefresh] = useState(0);
  const quoteGeneration = useQuoteGeneration(JSON.stringify([connected?.account.address, wallet?.cluster]), wallet?.signer);
  const pending = wallet && liveFinancialFlow?.pending(wallet);
  useEffect(() => { setQuote(null); setOutcome(null); setError(''); }, [connected?.account.address]);
  useEffect(() => {
    let current = true;
    setSolReadiness(null); setSolClaim(null); setSolError('');
    if (wallet?.cluster === 'devnet' && visitorSolFlow) void visitorSolFlow.readiness()
      .then(value => { if (current) setSolReadiness(value); })
      .catch(cause => { if (current) setSolError(textError(cause)); });
    return () => { current = false; };
  }, [connected?.account.address, wallet?.cluster, solRefresh]);
  async function requestSol() {
    if (!visitorSolFlow) return;
    setSolBusy(true); setSolError('');
    try {
      const result = await visitorSolFlow.claim();
      setSolClaim(result);
      if (result.state === 'FINALIZED' || result.state === 'ENOUGH_SOL') setSolRefresh(value => value + 1);
    } catch (cause) { setSolError(textError(cause)); }
    finally { setSolBusy(false); }
  }
  async function recheckSol() {
    if (!visitorSolFlow) return;
    setSolBusy(true); setSolError('');
    try {
      const result = await visitorSolFlow.recheck();
      setSolClaim(result);
      if (result.state === 'FINALIZED') setSolRefresh(value => value + 1);
    } catch (cause) { setSolError(textError(cause)); }
    finally { setSolBusy(false); }
  }
  const solPending = wallet?.cluster === 'devnet' && visitorSolFlow ? visitorSolFlow.pending() : null;
  async function getQuote() {
    if (!liveFinancialFlow) return;
    const version = quoteGeneration.current.version;
    const current = () => version === quoteGeneration.current.version;
    setBusy(true); setError(''); setOutcome(null); setQuote(null);
    try { const result = await liveFinancialFlow.quote({ action: 'faucet', marketId: null }); if (!current()) { if (result.kind === 'quote') liveFinancialFlow.cancelReview(result.quote); return; } if (result.kind === 'quote') { const failure = await liveFinancialFlow.prepareQuote(result.quote); if (!current()) { liveFinancialFlow.cancelReview(result.quote); return; } if (failure) setOutcome(failure); else setQuote(result.quote); } else setError(displayConsumerError(result.reason)); }
    catch (cause) { if (current()) setError(textError(cause)); } finally { setBusy(false); }
  }
  async function execute() {
    if (!liveFinancialFlow || !quote) return;
    setBusy(true); setError('');
    try { const result = await liveFinancialFlow.signReviewed(quote); setOutcome(result); setQuote(null); if (result.state === 'FINALIZED') onFinalized(); }
    catch (cause) { setError(textError(cause)); } finally { setBusy(false); }
  }
  async function recheck() {
    if (!liveFinancialFlow) return;
    setBusy(true); setError('');
    try { const result = await liveFinancialFlow.recheck(); setOutcome(result); if (result.state === 'FINALIZED') onFinalized(); }
    catch (cause) { setError(textError(cause)); } finally { setBusy(false); }
  }
  return <div className="page"><div className="profile-header"><span className="eyebrow orange-text">FUNDS</span><h1>Get ready to play<span className="title-dot">.</span></h1><p>Devnet SOL pays network fees. tUSD is the test asset for trading.</p></div>
  <section className="detail-panel finance-panel"><h2>1 · Check network fees</h2><p>Every chip and trade needs a small amount of Devnet SOL. It has no cash value.</p>
    {!wallet ? <Notice>Connect a Devnet wallet to check its balance.</Notice> : wallet.cluster !== 'devnet' ? <Notice>Connect a Devnet wallet.</Notice> :
      solReadiness ? <div className="finance-facts"><Fact label="Devnet SOL balance">{solAmount(solReadiness.balanceLamports)} SOL</Fact><Fact label="Fee readiness">{solReadiness.needsSol ? 'Needs SOL' : 'Ready'}</Fact></div> : !solError ? <p className="tiny muted">Checking Devnet SOL balance…</p> : null}
    {solError && <Notice error>{solError}</Notice>}
    {solClaim && <Notice error={solClaim.state === 'LIMIT_REACHED'}>{solClaim.state === 'FINALIZED' ? 'Devnet SOL received.' : solClaim.state === 'ENOUGH_SOL' ? 'This wallet has enough SOL.' : solClaim.state === 'LIMIT_REACHED' ? 'The in-app SOL limit has been reached. Use the Devnet faucet below.' : solClaim.state === 'DISABLED' ? 'In-app SOL is unavailable. Use the Devnet faucet below.' : 'SOL request pending. Check its status before trying another.'}{transactionHref(solClaim.signature, 'devnet') && <p><a href={transactionHref(solClaim.signature, 'devnet')!} target="_blank" rel="noopener noreferrer">View transfer ↗</a></p>}</Notice>}
    {wallet?.cluster === 'devnet' && <div className="finance-buttons"><button className="button button-dark" disabled={solBusy} onClick={() => setSolRefresh(value => value + 1)}>Refresh SOL balance</button>
      {solPending && <button className="button button-dark" disabled={solBusy} onClick={() => void recheckSol()}>Check existing SOL request</button>}
      {solReadiness?.needsSol && solReadiness.serverGrantEnabled && <button className="button button-blue" disabled={solBusy} onClick={() => void requestSol()}>{solPending ? 'Retry same SOL request' : 'Get Devnet SOL'}</button>}</div>}
    <p className="tiny muted">{wallet ? <>You can also use the <a href="https://faucet.solana.com/" target="_blank" rel="noopener noreferrer">Solana Devnet faucet ↗</a> for {wallet.address}. Copy your wallet address in your wallet before opening it.</> : <>Or use the <a href="https://faucet.solana.com/" target="_blank" rel="noopener noreferrer">Solana Devnet faucet ↗</a> after connecting a wallet.</>}</p>
  </section><section className="detail-panel finance-panel"><h2>2 · Request tUSD</h2><p>Review the amount, then confirm in your wallet.</p><details className="au-evidence-details"><summary>Asset details</summary><p>Network: Devnet · tUSD is a test asset. Devnet SOL covers network fees. Your balance updates after confirmation; request limits and retry times apply.</p></details>
    {isFixture || !liveFinancialFlow ? <Notice>tUSD is unavailable.</Notice> : !wallet ? <Notice>Connect a Solana wallet.</Notice> : wallet.cluster !== walletCluster ? <Notice>Wallet network does not match.</Notice> : null}
    {pending && <Notice>Unresolved request ID: {pending.requestId}{pending.signature && ` · Signature: ${pending.signature}`}</Notice>}
    {error && <Notice error>{error}</Notice>}
    {outcome && <Notice error={outcome.state === 'FAILED'}>{outcome.reason ? displayConsumerError(outcome.reason) : outcome.state} · Request ID: {outcome.requestId}</Notice>}
    {pending && <button className="button button-dark full" disabled={busy} onClick={() => void recheck()}>Check existing request</button>}
    {!quote && <button className="button button-blue full" disabled={busy || !wallet || !!pending || !liveFinancialFlow || !!solReadiness?.needsSol} onClick={() => void getQuote()}>{busy ? 'Checking…' : 'Check eligibility and quote'}</button>}
    {quote && <div className="finance-quote">{!busy && <QuoteExpiry remaining={quoteRemaining} />}<h3>Review payout terms</h3><div className="finance-facts"><Fact label="Expected receipt">{amount(quote.minReceiveAtoms)} tUSD</Fact><Fact label="Quote expiry">{date(quote.expiresAt)}</Fact></div>{!liveFinancialFlow?.canExecute('faucet') && <Notice>Signing is currently unavailable.</Notice>}<div className="finance-buttons"><button className="button button-dark" onClick={() => setQuote(null)}>Cancel</button><button className="button button-blue" disabled={busy || !liveFinancialFlow?.canExecute('faucet') || quoteRemaining === 0} onClick={() => void execute()}>Sign in wallet</button></div></div>}
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
  const quoteGeneration = useQuoteGeneration(JSON.stringify([connected?.account.address, wallet?.cluster, keyword, aliases]), wallet?.signer);
  const pending = wallet && liveFinancialFlow?.pending(wallet);
  useEffect(() => { setQuote(null); setOutcome(null); setError(''); }, [connected?.account.address]);
  async function getQuote() {
    if (!liveFinancialFlow) return;
    const version = quoteGeneration.current.version;
    const current = () => version === quoteGeneration.current.version;
    setBusy(true); setError(''); setOutcome(null); setQuote(null);
    try {
      const normalized = keyword.trim().toLowerCase().replace(/\s+/g, ' ');
      const list = aliases.split(',').map((value) => value.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean);
      const result = await liveFinancialFlow.quote({ action: 'registerMarket', marketId: null, keyword: normalized, aliases: list });
      if (!current()) { if (result.kind === 'quote') liveFinancialFlow.cancelReview(result.quote); return; } if (result.kind === 'quote') { const failure = await liveFinancialFlow.prepareQuote(result.quote); if (!current()) { liveFinancialFlow.cancelReview(result.quote); return; } if (failure) setOutcome(failure); else setQuote(result.quote); } else setError(displayConsumerError(result.reason));
    } catch (cause) { if (current()) setError(textError(cause)); } finally { setBusy(false); }
  }
  async function execute() {
    if (!liveFinancialFlow || !quote) return;
    setBusy(true); setError('');
    try { const result = await liveFinancialFlow.signReviewed(quote); setOutcome(result); setQuote(null); if (result.state === 'FINALIZED') onFinalized(); }
    catch (cause) { setError(textError(cause)); } finally { setBusy(false); }
  }
  async function recheck() {
    if (!liveFinancialFlow) return;
    setBusy(true); setError('');
    try { const result = await liveFinancialFlow.recheck(); setOutcome(result); if (result.state === 'FINALIZED') onFinalized(); }
    catch (cause) { setError(textError(cause)); } finally { setBusy(false); }
  }
  return <div className="page"><div className="profile-header"><span className="eyebrow orange-text">NEW MARKET</span><h1>Register a keyword<span className="title-dot">.</span></h1><p>Register an English keyword and limited aliases. The fee is 10 tUSD plus network fees. Registration does not guarantee data coverage or trading availability.</p></div><section className="detail-panel finance-panel"><h2>Review registration terms</h2>
    <div className="finance-form"><label>English keyword<input disabled={busy} value={keyword} placeholder="example keyword" onChange={(event) => { setKeyword(event.target.value); setQuote(null); }} /></label><label>Aliases · comma separated<input disabled={busy} value={aliases} placeholder="#examplekeyword" onChange={(event) => { setAliases(event.target.value); setQuote(null); }} /></label></div>
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
