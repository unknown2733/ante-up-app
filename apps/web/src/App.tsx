import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { FreeRecord, MarketView, Mode, OpenPreview } from '../../../contracts/types';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import { api, isFixture, liveFreeFlow, transportMode } from './api';
import { DEMO_WALLET } from './wallet';
import { currentWalletContext, walletClient, walletCluster, WalletPanel, WalletProfile } from './walletSdk';
import type { FreeOutcome, FreeProgress, FreeRequest, FreeReview } from './liveFree';
import { FinancialFaucet, FinancialMarket, FinancialRegistration, PrivateFinancialPanel } from './Financial';
import { displayConsumerError } from './consumer-ui/copy';
import type { ConsumerAction, ConsumerMarket, ConsumerMode, ConsumerNote, ConsumerPeriod, ConsumerSeriesKind, MarketHistory } from '../../../contracts/consumer';
import { ConsumerShell, MarketDiscovery, ActionTabs, mergeConsumerMarkets } from './consumer-ui';
import type { ActionTab, ConsumerRoute } from './consumer-ui';
import { ConsumerChart } from './charts/ConsumerChart';
import { SocialLeaderboard, SocialNote, SocialNoteEditor, SocialNoteHistory, SocialProfile } from './social/Social';
import { liveConsumerHttp, referenceReadApi } from './api';
import { isReferenceConsumerId } from './reference/referenceData';
import { ReferenceMarketActions } from './reference/ReferenceMarketActions';
import { DocsPage } from './docs';
import { ChipCompletion } from './consumer-ui/ChipCompletion';
import { ResultCardShare } from './sharing/ResultCardShare';
import { createResultCard } from './sharing/resultCard';
import { ExecutionResult } from './sharing/ChipExecutionResult';
import { RecordEvidence } from './sharing/RecordEvidence';
import { RecordSummary } from './sharing/RecordSummary';
import { SubjectImage, WalletAvatar } from './media/SubjectImage';
import { artworkSource } from './consumer-ui/artwork';
import { marketDisplayTitle, marketDisplaySubtitle, withVerifiedSubjectMedia } from './consumer-ui/catalog';
import './consumer-ui/tradingLayout.css';

const renderAvatar = (props: { address: string; src?: string; className: string }) => <WalletAvatar {...props} />;
const renderSubjectImage = (props: { src?: string; alt: string; className: string }) => <SubjectImage {...props} />;

function go(path: string) { window.history.pushState(null, '', path); window.dispatchEvent(new PopStateEvent('popstate')); window.scrollTo(0, 0); }
function Link({ to, children, className = '' }: { to: string; children: ReactNode; className?: string }) {
  return <a href={to} className={className} onClick={(event) => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); go(to); } }}>{children}</a>;
}
function usePath() {
  const [path, setPath] = useState(window.location.pathname + window.location.search);
  useEffect(() => { const update = () => setPath(window.location.pathname + window.location.search); window.addEventListener('popstate', update); return () => window.removeEventListener('popstate', update); }, []);
  return path;
}
function useData<T>(load: () => Promise<{ data: T }>, deps: unknown[]) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setValue(null);
    load().then((response) => { if (active) setValue(response.data); }).catch((cause: unknown) => { if (active) setError(displayConsumerError(cause instanceof Error ? cause.message : null, 'Could not load this data.')); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  // Depend on the caller's stable primitive keys, not on its inline load closure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { value, error, loading };
}
// Retain only the same identity while refreshing. A new revision is blocked during
// render, before the effect starts, so stale data cannot authorize an action.
function useRetainedData<T>(load: () => Promise<{ data: T }>, identity: string, revision: string) {
  const [state, setState] = useState<{ identity: string; revision: string; value: T | null; error: string; loading: boolean }>({ identity, revision, value: null, error: '', loading: true });
  useEffect(() => {
    let active = true;
    setState(previous => ({ identity, revision, value: previous.identity === identity ? previous.value : null, error: '', loading: true }));
    load().then(response => {
      if (active) setState({ identity, revision, value: response.data, error: '', loading: false });
    }).catch((cause: unknown) => {
      if (active) setState(previous => ({ identity, revision, value: previous.identity === identity ? previous.value : null, error: displayConsumerError(cause instanceof Error ? cause.message : null, 'Could not refresh this data.'), loading: false }));
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, revision]);
  const sameIdentity = state.identity === identity;
  const current = sameIdentity && state.revision === revision;
  return { value: sameIdentity ? state.value : null, error: current ? state.error : '', loading: !current || state.loading };
}

const marketName = (id: string) => ({ 'm-attention': 'attention', 'm-meme': 'meme', 'm-outage': 'outage', 'm-signal': 'signal', 'm-wait': 'moment', 'fixture:sol': 'solana', 'fixture:unready': 'unready' })[id as 'm-attention'] || id;
const statusText = { PREPARING: 'Preparing data', VALID: 'Data current', LOW_ACTIVITY: 'Low activity', OUTAGE: 'Data unavailable' };
const phaseText = { CURVE: 'Bonding curve', GRADUATION_WAIT: 'Graduation pending', INDEXED: 'Index market' };
function date(seconds: number | null) { return seconds ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }).format(seconds * 1000) + ' UTC' : '—'; }
function percent(value: { numerator: string; denominator: string } | null, digits = 1) {
  if (!value || value.denominator === '0') return 'N/A';
  const amount = Number(value.numerator) / Number(value.denominator) * 100;
  return `${amount > 0 ? '+' : ''}${amount.toFixed(digits)}%`;
}
function atoms(value: string) {
  const whole = value.length > 6 ? value.slice(0, -6) : '0';
  const fraction = value.slice(-6).padStart(6, '0').replace(/0+$/, '');
  return `${BigInt(whole).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
}
function shortWallet(wallet: string) { return wallet === DEMO_WALLET ? 'My sample profile' : wallet.replace('demo:', '@'); }

function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'blue' | 'orange' | 'red' | 'green' }) { return <span className={`tag tag-${tone}`}>{children}</span>; }
function Notice({ children, tone = 'blue' }: { children: ReactNode; tone?: 'blue' | 'orange' | 'red' }) { return <div className={`notice notice-${tone}`}>{children}</div>; }
function Empty({ title, children }: { title: string; children?: ReactNode }) { return <div className="empty"><div className="empty-icon">○</div><strong>{title}</strong>{children && <p>{children}</p>}</div>; }
function ErrorBox({ message }: { message: string }) { return <Notice tone="red">{displayConsumerError(message)}</Notice>; }

function RecordCard({ record, compact = false, preview }: { record: FreeRecord; compact?: boolean; preview?: OpenPreview }) {
  const result = record.result?.kind === 'return' ? percent(record.result) : record.status === 'CLOSED_NA' ? 'N/A' : preview?.status === 'REFERENCE' ? percent(preview.referenceReturn) : 'Open';
  const tone = record.status === 'CLOSED_NA' ? 'orange' : record.status === 'OPEN' ? 'blue' : record.result?.kind === 'return' && Number(record.result.numerator) < 0 ? 'red' : 'green';
  return <Link to={`/records/${encodeURIComponent(record.id)}`} className={`record-card ${compact ? 'compact' : ''}`}>
    <div className="record-card-top"><div className="keyword"><span className="keyword-mark">◉</span> {marketName(record.marketId)}</div><Tag tone={tone}>{record.status === 'OPEN' ? 'Chip active' : record.status === 'CLOSED_NA' ? 'N/A result' : 'Chip returned'}</Tag></div>
    <div className="record-card-bottom"><div><span className="muted tiny">{record.status === 'OPEN' ? 'Placed' : 'Returned'} · {date(record.exit?.executedAt || record.entry.executedAt)}</span><div className="tiny muted">{record.status === 'OPEN' ? preview?.status === 'REFERENCE' ? `Current reference · ${date(preview.observedAt)} · excluded from ranking` : 'No reference result · excluded from ranking' : record.status === 'CLOSED_NA' ? record.result?.kind === 'na' && displayConsumerError(record.result.reason) : record.proofId ? 'Verify record →' : 'Proof pending →'}</div></div><strong className={`record-value ${tone}`}>{result}</strong></div>
  </Link>;
}

function LiveFreeAction({ market, recordId, mode, profileLoading, limitReached, projectionWaiting, changed }: { market: MarketView; recordId: string | null; mode: Mode | null; profileLoading: boolean; limitReached: boolean; projectionWaiting: boolean; changed: () => void }) {
  const connected = useConnectedWallet(walletClient);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<FreeProgress | null>(null);
  const [outcome, setOutcome] = useState<FreeOutcome | null>(null);
  const [review, setReview] = useState<FreeReview | null>(null);
  const [remaining, setRemaining] = useState(0);
  const reviewRef = useRef<FreeReview | null>(null);
  const contextVersion = useRef(0);
  const running = useRef(false);
  const [outcomeAction, setOutcomeAction] = useState<FreeRequest['action']>(recordId ? 'closeFree' : 'openFree');
  const outcomeRequest = useRef<FreeRequest | null>(null);
  const wallet = currentWalletContext();
  const requestValue: FreeRequest = { market, action: recordId ? 'closeFree' : 'openFree', recordId };
  const unavailable = mode !== walletCluster ? 'The API network does not match your wallet network.' : !liveFreeFlow ? 'Chip placement is unavailable here.' : limitReached && !recordId ? 'You have reached the three active chip limit.' : liveFreeFlow.supportReason(requestValue, wallet);
  function cancelReview() {
    if (reviewRef.current) liveFreeFlow?.cancelReview(reviewRef.current);
    reviewRef.current = null; setReview(null); setRemaining(0); setProgress(null);
  }
  useEffect(() => {
    contextVersion.current++; cancelReview();
    return () => { contextVersion.current++; if (reviewRef.current) liveFreeFlow?.cancelReview(reviewRef.current); reviewRef.current = null; };
  }, [connected?.account.address, market.id, recordId, mode]);
  useEffect(() => {
    if (!review || !liveFreeFlow) return;
    const update = () => setRemaining(liveFreeFlow!.reviewSecondsRemaining(review));
    update(); const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [review]);
  useEffect(() => {
    if (outcome) return;
    const pendingOutcome = liveFreeFlow?.pending(requestValue, currentWalletContext()) ?? null;
    if (pendingOutcome) { outcomeRequest.current = requestValue; setOutcomeAction(requestValue.action); setOutcome(pendingOutcome); }
  }, [recordId, outcome]);
  async function run() {
    if (!liveFreeFlow || running.current || unavailable || profileLoading) return;
    const version = contextVersion.current;
    running.current = true; outcomeRequest.current = requestValue; setOutcomeAction(requestValue.action); setBusy(true); setOutcome(null); setProgress('AUTH');
    try {
      cancelReview();
      const result = await liveFreeFlow.prepare(requestValue, setProgress);
      if (version !== contextVersion.current) { if (result.state === 'PREPARED') liveFreeFlow.cancelReview(result.review); return; }
      if (result.state === 'PREPARED') {
        reviewRef.current = result.review; setReview(result.review); setRemaining(liveFreeFlow.reviewSecondsRemaining(result.review)); setProgress(null);
      } else setOutcome(result);
    } finally { running.current = false; setBusy(false); }
  }
  async function sign() {
    if (!liveFreeFlow || !review || running.current || unavailable || profileLoading) return;
    const version = contextVersion.current;
    running.current = true; setBusy(true); setOutcome(null); setProgress('AWAITING_SIGNATURE');
    const signing = review;
    reviewRef.current = null; setReview(null);
    try {
      const result = await liveFreeFlow.signReviewed(signing, setProgress);
      if (version !== contextVersion.current) return;
      setOutcome(result);
      if (result.state === 'FINALIZED') changed();
    } finally { running.current = false; setBusy(false); }
  }
  async function recheck() {
    if (!liveFreeFlow || running.current || !outcome?.requestId) return;
    running.current = true; setBusy(true);
    try {
      const result = await liveFreeFlow.recheck(outcomeRequest.current ?? requestValue, outcome.requestId, outcome.signature);
      setOutcome(result);
      if (result.state === 'FINALIZED') changed();
    } finally { running.current = false; setBusy(false); }
  }
  const completedRecord = useData(() => outcome?.state === 'FINALIZED' && outcome.recordId ? api.getRecord(outcome.recordId) : Promise.resolve({ data: null }), [outcome?.state, outcome?.recordId, projectionWaiting]);
  const confirmedRecord = completedRecord.value?.id === outcome?.recordId && completedRecord.value?.marketId === market.id && completedRecord.value?.wallet === connected?.account.address && completedRecord.value?.finality === 'finalized' ? completedRecord.value : null;
  const pending = outcome?.state === 'UNKNOWN' || outcome?.state === 'CONFIRMED' || outcome?.state === 'SUBMITTED';
  const disabled = busy || profileLoading || !!unavailable || pending || outcome?.state === 'FINALIZED';
  const progressText: Record<FreeProgress, string> = { AUTH: 'Authenticating wallet…', PREPARING: 'Preparing transaction…', AWAITING_SIGNATURE: 'Waiting for wallet signature…', SUBMITTED: 'Submitted · checking finality…', CONFIRMED: 'Confirming on chain…' };
  return <>
    {outcome?.state !== 'FINALIZED' && <button className={`button full ${disabled ? 'button-disabled' : 'button-chip'}`} disabled={disabled} onClick={review && remaining > 0 ? sign : run}>{busy ? progressText[progress ?? 'AUTH'] : review ? remaining > 0 ? 'Sign in wallet' : 'Review chip request' : recordId ? 'Take back chip' : 'Place chip'} <span>↗</span></button>}
    {review && <p className="tiny muted">{remaining > 0 ? `${recordId ? 'Take back' : 'Place'} one chip · ready to sign for ${remaining}s. Tap Sign in wallet to continue.` : 'Chip request expired without being sent. Review it again for a fresh request.'}</p>}
    {review && <button className="button button-dark full" disabled={busy} onClick={cancelReview}>Cancel review</button>}
    {unavailable && <p className="tiny muted">{displayConsumerError(unavailable)}</p>}
    {outcome && (outcome.state === 'FINALIZED' ? <ChipCompletion title={market.keyword} record={confirmedRecord}><ExecutionResult outcome={outcome} action={outcomeAction} mode={mode} onNavigate={go} /></ChipCompletion> : <ExecutionResult outcome={outcome} action={outcomeAction} mode={mode} onNavigate={go} />)}
    {outcome?.state === 'FINALIZED' && <button className="button button-dark full" disabled={busy || profileLoading || projectionWaiting} onClick={() => { setOutcome(null); setProgress(null); outcomeRequest.current = null; }}>Continue in this market</button>}
    {projectionWaiting && <button className="button button-dark full" disabled={busy || profileLoading} onClick={changed}>Refresh finalized activity</button>}
    {pending && <button className="button button-dark full" disabled={busy || !connected} onClick={recheck}>Check existing request</button>}
  </>;
}

function MarketPage({ id, refresh, changed, mode, section = 'call', compact = false }: { id: string; refresh: number; changed: () => void; mode: Mode | null; section?: ActionTab; compact?: boolean }) {
  const market = useRetainedData(async () => {
    const response = await api.getMarket(id);
    if (response.data && response.data.id !== id) throw new Error('Market identity could not be verified.');
    return response;
  }, `${mode}:${id}`, String(refresh));
  const connected = useConnectedWallet(walletClient);
  const walletAddress = connected?.account.address ?? null;
  const [profileRefresh, setProfileRefresh] = useState(0);
  const [, redrawProjection] = useState(0);
  const profile = useRetainedData(async () => {
    const expectedWallet = isFixture ? DEMO_WALLET : walletAddress;
    const response = expectedWallet ? await api.getProfile(expectedWallet) : { data: null };
    if (response.data && response.data.wallet !== expectedWallet) throw new Error('Wallet profile identity could not be verified.');
    return response;
  }, `${mode}:${id}:${walletAddress ?? (isFixture ? DEMO_WALLET : 'disconnected')}`, `${refresh}:${profileRefresh}`);
  const projectionWait = liveFreeFlow?.projectionPending(id, currentWalletContext());
  useEffect(() => {
    if (!profile.loading && !profile.error && liveFreeFlow?.observeProfile(id, currentWalletContext(), profile.value)) redrawProjection(value => value + 1);
  }, [id, walletAddress, profile.loading, profile.error, profile.value]);
  useEffect(() => {
    if (!projectionWait) return;
    let polls = 0;
    const timer = window.setInterval(() => {
      setProfileRefresh(value => value + 1);
      if (++polls >= 15) window.clearInterval(timer);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [id, walletAddress, projectionWait?.requestId]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const m = market.value;
  const open = profile.value?.openRecords.find((record) => record.marketId === id);
  async function mutate() {
    if (!m || market.loading || market.error || profile.loading || profile.error) return;
    setBusy(true); setMessage('');
    try {
      const response = open ? await api.closeFree(DEMO_WALLET, open.id) : await api.openFree(DEMO_WALLET, m.id);
      if (response.kind === 'fixture') { changed(); setMessage(open ? 'Sample chip returned. Review its illustrative result.' : 'Sample chip placed. No wallet signature or chain record was created.'); }
      else setMessage(displayConsumerError(response.reason));
    } finally { setBusy(false); }
  }
  if (market.loading && !m) return <div className="page"><p className="muted">Loading markets…</p></div>;
  if (market.error && !m) return <div className="page"><ErrorBox message={market.error} /></div>;
  if (!m) return <div className="page"><Empty title="Market not found" /></div>;
  const refreshBlocked = market.loading || !!market.error;
  const freeAllowed = m.capabilities[open ? 'closeFree' : 'openFree'];
  const ownLimit = (profile.value?.openRecords.length || 0) >= 3;
  const duplicate = !open && profile.value?.openRecords.some((record) => record.marketId === m.id);
  return <div className={`page${compact ? ' au-order-page' : ''}`}>
    {refreshBlocked && <Notice tone={market.error ? 'red' : 'blue'}>{market.error ? `Could not verify the latest market data. New actions are blocked. ${market.error}` : 'Refreshing market data. New actions are temporarily blocked.'}</Notice>}
    {compact && <div className="au-order-context"><div className="tag-row"><Tag tone="blue">{phaseText[m.phase]}</Tag><Tag tone={m.dataStatus === 'VALID' ? 'green' : 'orange'}>{statusText[m.dataStatus]}</Tag>{!m.supported && <Tag tone="orange">Data coverage pending</Tag>}</div>{section !== 'call' && <div className="au-order-price"><span>{m.price?.kind === 'curve' ? 'Curve quote' : 'Index reference'}</span><strong>{m.price ? `${atoms(m.price.atoms)} tUSD` : 'Unavailable'}</strong><small>Final price confirmed in your quote</small></div>}{section === 'liquidity' && <p className="tiny muted">Reference price and vault NAV are separate. Load your balances below for current vault NAV and shares.</p>}</div>}
    {!compact && <><div className="detail-title"><span className="eyebrow blue-text">MARKET</span><div className="tag-row"><Tag tone="blue">{phaseText[m.phase]}</Tag><Tag tone={m.dataStatus === 'VALID' ? 'green' : m.dataStatus === 'OUTAGE' ? 'red' : 'orange'}>{statusText[m.dataStatus]}</Tag>{!m.supported && <Tag tone="orange">Data coverage pending</Tag>}</div></div>
    <div className="detail-grid"><div className="metric-card primary-metric"><span className="eyebrow">{m.price?.kind === 'curve' ? 'Curve quote' : 'Index reference'}</span><strong>{m.price ? atoms(m.price.atoms) : '—'}<small>{m.price ? ' tUSD' : ''}</small></strong><p>{isFixture ? 'Sample reference · not an execution price' : m.price?.executable ? 'Published snapshot · rechecked at execution' : 'Reference only · unavailable for execution'}</p></div><div className="metric-card"><span className="eyebrow">Fixed price cap</span><strong>{m.anchor ? `${atoms(m.anchor.maxPriceAtoms)} tUSD` : '—'}</strong><p>{m.anchor ? 'Graduation anchor' : 'Before graduation / no anchor'}</p></div></div>
    <div className="comparison-strip"><div><span>Attention change since chip placement</span><strong>{open ? 'Chip active' : 'See activity'}</strong></div><div><span>Weekly price change</span><strong>No data</strong></div><div><span>My trade P&L</span><strong>No P&L data</strong></div></div></>}
    {section === 'call' && <section className="detail-panel au-chip-panel"><p className="au-chip-subject">{marketDisplayTitle(m.keyword)} · 1 chip · Free participation</p><div className="section-head"><div><span className="eyebrow orange-text">CHIPS</span><h2>{open ? 'Your chip is active' : 'Place a chip'}</h2></div><span className="au-chip-count" aria-label={`${profile.value?.openRecords.length ?? 'Unknown'} of 3 active chips`}><span aria-hidden="true">◉</span> {profile.value?.openRecords.length ?? '—'} / 3 active</span></div><p>{open ? 'Take back your chip to finalize the attention result and free up this chip.' : 'Place a chip on this keyword and take it back later. The result tracks attention change, not a cash payout.'}</p>
      <details className="au-chip-rules" open={compact ? undefined : true}><summary>Chip limits</summary><div className="rule-list"><div><span>Active chips</span><strong>{profile.value?.openRecords.length ?? '—'} / 3</strong></div><div><span>Per market</span><strong>Maximum one</strong></div><div><span>New placements</span><strong>6 per wallet / 24 h · 100 total</strong></div></div></details>
      {m.dataStatus === 'LOW_ACTIVITY' && <Notice tone="orange">Activity is low. Chips remain available; new paid trades are paused.</Notice>}
      {m.dataStatus === 'OUTAGE' && <Notice tone="red">You can still place or take back a chip while data is unavailable. Taking it back now may record N/A.</Notice>}
      {m.dataStatus === 'PREPARING' && <Notice tone="orange">The index is preparing. A missing entry reference will not be backfilled.</Notice>}
      {!isFixture && <p className="tiny muted">New wallet? <Link to="/faucet">Check Devnet SOL for network fees ↗</Link></p>}
      {message && <Notice tone="blue">{message}</Notice>}
      {!isFixture && profile.error && <Notice tone="red">Could not verify your active chips, so another action is blocked. {profile.error}</Notice>}
      {isFixture ? <button className="button button-chip full" disabled={busy || refreshBlocked || profile.loading || !!profile.error || freeAllowed?.allowed === false || (!!ownLimit && !open) || !!duplicate} onClick={mutate}>{busy ? 'Processing…' : open ? 'Take back chip' : 'Place chip'} <span>↗</span></button> : <LiveFreeAction key={`${mode}:${id}:${walletAddress ?? 'disconnected'}`} market={m} recordId={open?.id ?? null} mode={mode} profileLoading={refreshBlocked || profile.loading || !!profile.error} limitReached={ownLimit} projectionWaiting={!!projectionWait} changed={changed} />}
      {(freeAllowed?.allowed === false || (ownLimit && !open)) && <p className="tiny muted">{ownLimit && !open ? 'You have reached the three active chip limit.' : displayConsumerError(freeAllowed?.detail ?? freeAllowed?.reason)}</p>}
      <p className="tiny muted">{isFixture ? 'This changes a browser-only sample record. It does not submit a transaction or issue proof.' : 'Your wallet confirms each chip action.'}</p>
      {open && <RecordCard record={open} compact />}
    </section>}
    {section !== 'call' && <><Link to="/faucet" className="text-link">Check SOL &amp; get tUSD ↗</Link><FinancialMarket key={`${m.id}:${section}`} market={m} refreshBlocked={refreshBlocked} section={section === 'trade' ? 'money' : section === 'liquidity' ? 'lp' : 'pro'} onFinalized={changed} /></>}
    {m.snapshot && <details className="au-evidence-details"><summary>Data and market details</summary><div className="snapshot-strip"><span>Observed {date(m.snapshot.payload.dataThrough)}</span><span>Formula {m.snapshot.payload.formulaVersion}</span><span>Query {m.snapshot.payload.queryHash.slice(0, 8)}…</span><Tag tone={m.snapshot.payload.admission.state === 'OPEN' ? 'green' : 'orange'}>{m.snapshot.payload.admission.state === 'OPEN' ? 'New entries open' : m.snapshot.payload.admission.state === 'RECOVERING' ? `Recovery checks ${m.snapshot.payload.admission.recoveryCount}/2` : 'New entries paused'}</Tag></div></details>}
  </div>;
}

function ProfilePage({ wallet, refresh, own = false }: { wallet: string; refresh: number; own?: boolean }) {
  const profile = useData(() => api.getProfile(wallet), [wallet, refresh]);
  if (profile.loading) return <div className="page"><p className="muted">Loading activity…</p></div>;
  if (profile.error) return <div className="page"><ErrorBox message={profile.error} /></div>;
  const p = profile.value;
  if (!p) return null;
  return <div className="page"><div className="profile-header"><span className="eyebrow blue-text">{own ? 'MY RECORD' : 'PUBLIC PROFILE'}</span><h1>{own ? 'My activity' : shortWallet(wallet)}<span className="title-dot">.</span></h1><p>{own ? isFixture ? 'Sample chips and illustrative results from this browser.' : 'Chips and finalized results from your connected wallet.' : 'Only chip activity is public. Pro and liquidity holdings are not shown here.'}</p></div>
    <div className="profile-stats"><div><span>Average valid result</span><strong>{p.averageReturn ? percent(p.averageReturn) : '—'}</strong><small>{p.averageReturn ? 'Finalized chip results only' : isFixture && own ? 'Sample ranking snapshot pending' : 'No eligible results'}</small></div><div><span>Valid results</span><strong>{p.closedValidCount}</strong><small>N/A {p.closedNaCount} excluded</small></div><div><span>Active chips</span><strong>{p.openRecords.length}</strong><small>Excluded from ranking</small></div></div>
    {p.leaderboardStatus === 'HELD_CALCULATION_ERROR' && <Notice tone="red">Ranking is on hold while a calculation error is reviewed. Negative chip results remain included.</Notice>}
    <section className="section no-pad"><div className="section-head"><div><span className="eyebrow blue-text">ACTIVE CHIPS</span><h2>Active chips</h2></div><span className="section-note">Subject and placement time are public</span></div>{p.openRecords.length ? <div className="record-list">{p.openRecords.map((record) => <RecordCard key={record.id} record={record} preview={p.openPreviews?.find((item) => item.recordId === record.id)} />)}</div> : <Empty title="No active chips">Explore a supported market to place a chip.</Empty>}</section>
    <section className="section no-pad"><div className="section-head"><div><span className="eyebrow orange-text">HISTORY</span><h2>Chip history</h2></div><span className="section-note">Includes negative and N/A results</span></div>{p.closedRecords.length ? <div className="record-list">{p.closedRecords.map((record) => <RecordCard key={record.id} record={record} />)}</div> : <Empty title="No completed chips" />}</section>
    {own && !isFixture && <PrivateFinancialPanel wallet={wallet} refresh={refresh} />}
    {own && isFixture && <Notice tone="blue">Sample activity is stored in this browser only. It has no wallet signature, chain record, or real SAS proof.</Notice>}
  </div>;
}

function RecordPage({ id }: { id: string }) {
  const record = useData(() => api.getRecord(id), [id]);
  const connected = useConnectedWallet(walletClient);
  const marketId = record.value?.marketId;
  const market = useData(() => marketId ? api.getMarket(marketId) : Promise.resolve({ data: null }), [marketId]);
  const proofId = record.value?.proofId;
  const proof = useData(() => proofId ? api.getProof(proofId) : Promise.resolve({ data: null }), [proofId]);
  if (record.loading) return <div className="page"><p className="muted">Loading activity…</p></div>;
  if (record.error) return <div className="page"><ErrorBox message={record.error} /></div>;
  const r = record.value;
  if (!r) return <div className="page"><Empty title="Record not found" /></div>;
  const p = proof.value;
  const shareCard = market.loading || proof.loading ? null : createResultCard(r, market.value?.keyword ?? 'Keyword market', transportMode(), p, !!proof.error);
  return <div className="page au-record-page"><Link to={r.wallet === DEMO_WALLET || r.wallet === connected?.account.address ? '/me' : `/u/${encodeURIComponent(r.wallet)}`} className="back">← Profile</Link>
    <RecordSummary record={r} title={market.value?.keyword ?? marketName(r.marketId)} proof={p} mode={transportMode()} loading={proof.loading} unavailable={!!proof.error} />
    {r.status === 'OPEN' && <Link to={`/markets/${encodeURIComponent(r.marketId)}`} className="button button-chip full">{r.wallet === connected?.account.address || isFixture ? 'Go to take back chip' : 'View market'} ↗</Link>}
    <details className="au-evidence-details"><summary>Record details · original values</summary><div className="au-evidence-grid"><div><span>Record ID</span><code>{r.id}</code></div><div><span>Result basis</span><code>{r.result?.kind === 'return' ? `${r.result.numerator}/${r.result.denominator}` : r.result?.kind === 'na' ? displayConsumerError(r.result.reason) : 'Not finalized'}</code></div><div><span>Placement slot</span><code>{r.entry.slot}</code></div><div><span>Placement index (h)</span><code>{r.entry.h ? `${r.entry.h.numerator}/${r.entry.h.denominator}` : r.entry.unavailableReason ? displayConsumerError(r.entry.unavailableReason) : 'Unavailable'}</code></div>{r.exit && <><div><span>Return slot</span><code>{r.exit.slot}</code></div><div><span>Return index (h)</span><code>{r.exit.h ? `${r.exit.h.numerator}/${r.exit.h.denominator}` : r.exit.unavailableReason ? displayConsumerError(r.exit.unavailableReason) : 'Unavailable'}</code></div></>}</div></details>
    <div id="record-proof"><RecordEvidence record={r} proof={p} mode={transportMode()} loading={proof.loading} unavailable={!!proof.error} /></div>
    {shareCard && <ResultCardShare key={r.id} data={shareCard} />}
    <div className="record-footer"><Link to={`/u/${encodeURIComponent(r.wallet)}`} className="text-link">View public profile ↗</Link><span className="tiny muted">Shared cards are snapshots of the record</span></div>
  </div>;
}

function ProofPage({ id }: { id: string }) {
  const proof = useData(() => api.getProof(id), [id]);
  const recordId = proof.value?.recordId;
  const record = useData(() => recordId ? api.getRecord(recordId) : Promise.resolve({ data: null }), [recordId]);
  return <div className="page"><Link to="/markets" className="back">← Explore</Link><div className="profile-header"><span className="eyebrow blue-text">PROOF HISTORY</span><h1>Proof history<span className="title-dot">.</span></h1></div>{proof.loading ? <p>Loading…</p> : proof.error ? <ErrorBox message={proof.error} /> : proof.value ? <>
    <Link to={`/records/${encodeURIComponent(proof.value.recordId)}`} className="text-link">View chip record ↗</Link>
    {record.loading ? <p className="muted">Loading source record…</p> : record.error ? <ErrorBox message={record.error} /> : record.value?.id === proof.value.recordId ? <RecordEvidence record={record.value} proof={proof.value} mode={transportMode()} /> : <ErrorBox message="The proof's source record is unavailable or does not match." />}
  </> : <Empty title="Proof not found" />}</div>;
}

const consumerHref = (route: ConsumerRoute) => route === 'discover' ? '/markets' : route === 'activity' ? '/me' : route === 'funds' ? '/faucet' : route === 'docs' ? '/docs' : '/leaderboard';
const marketHref = (id: string) => `/markets/${encodeURIComponent(id)}`;
const actorHref = (id: string, actionId?: string) => `/u/${encodeURIComponent(id)}${actionId ? `?action=${encodeURIComponent(actionId)}` : ''}`;
const chartHref = (action: ConsumerAction) => `${marketHref(action.marketId)}?period=ALL&action=${encodeURIComponent(action.id)}`;
function consumerRead(mode: ConsumerMode) {
  if (mode === 'REFERENCE') return referenceReadApi;
  if (mode !== 'LIVE') throw new Error('This example is no longer published. Open Explore for current subjects.');
  if (!liveConsumerHttp) throw new Error('Devnet markets are unavailable. Configure the API connection to view them.');
  const read = liveConsumerHttp.read;
  return { ...read, listMarkets: async () => (await read.listMarkets()).map(withVerifiedSubjectMedia) };
}
function consumerData<T>(load: () => Promise<T>) { return Promise.resolve().then(load).then(data => ({ data })); }
function decodeRouteId(value: string | undefined) { try { return value ? decodeURIComponent(value) : null; } catch { return null; } }

interface CatalogState { markets: ConsumerMarket[]; liveError: string; loading: boolean }
function useUnifiedCatalog(refresh: number): CatalogState {
  const [state, setState] = useState<CatalogState>({ markets: [], liveError: '', loading: true });
  useEffect(() => {
    let active = true;
    setState(previous => ({ ...previous, loading: true }));
    const load = () => Promise.allSettled([referenceReadApi.listMarkets(), liveConsumerHttp ? liveConsumerHttp.read.listMarkets() : Promise.reject(new Error('Devnet API is not configured.'))]).then(results => {
      if (!active) return;
      const references = results[0].status === 'fulfilled' ? results[0].value : [];
      const live = results[1].status === 'fulfilled' ? results[1].value.map(withVerifiedSubjectMedia) : [];
      const liveError = results[1].status === 'rejected' ? displayConsumerError(results[1].reason instanceof Error ? results[1].reason.message : null, 'Devnet markets are unavailable.') : '';
      setState({ markets: mergeConsumerMarkets(references, live), liveError, loading: false });
    });
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    const onVisibility = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refresh]);
  return state;
}

interface HistoryState { value: MarketHistory | null; loading: boolean; refreshing: boolean; stale: boolean; error: string; refreshedAtMs: number | null }
function useConsumerHistory(mode: ConsumerMode, id: string, period: ConsumerPeriod, refresh: number): HistoryState {
  const [state, setState] = useState<HistoryState>({ value: null, loading: true, refreshing: false, stale: false, error: '', refreshedAtMs: null });
  const manualRefresh = useRef<(() => void) | null>(null);
  const lastRefresh = useRef(refresh);
  useEffect(() => {
    let active = true;
    let busy = false;
    let queued = false;
    let controller: AbortController | null = null;
    setState(previous => mode === 'LIVE' && previous.value?.market.id === id && previous.value.source.mode === mode
      ? { ...previous, loading: false, refreshing: true, stale: false, error: '' }
      : { value: null, loading: true, refreshing: false, stale: false, error: '', refreshedAtMs: null });
    const visible = () => document.visibilityState === 'visible';
    function load(queueIfBusy = false) {
      if (!active || (mode === 'LIVE' && !visible())) return;
      if (busy) { if (queueIfBusy) queued = true; return; }
      busy = true;
      const nextController = new AbortController();
      controller = nextController;
      setState(previous => ({ ...previous, loading: previous.value === null, refreshing: previous.value !== null }));
      Promise.resolve().then(() => mode === 'REFERENCE'
        ? referenceReadApi.getHistory(id, period)
        : liveConsumerHttp ? liveConsumerHttp.getHistory(id, period, nextController.signal) : Promise.reject(new Error('Live Devnet markets are unavailable.')))
        .then(value => {
          if (value && (value.market.id !== id || value.period !== period || value.source.mode !== mode || value.market.source.mode !== mode || (mode === 'LIVE' && value.market.liveMarketId && value.market.liveMarketId !== id))) throw new Error('Market history identity or mode does not match this route.');
          if (active && !nextController.signal.aborted) setState({ value: value ? { ...value, market: withVerifiedSubjectMedia(value.market) } : null, loading: false, refreshing: false, stale: false, error: '', refreshedAtMs: Date.now() });
        })
        .catch(reason => {
          if (!active || nextController.signal.aborted) return;
          const error = displayConsumerError(reason instanceof Error ? reason.message : null, 'Could not refresh market history.');
          setState(previous => ({ ...previous, loading: false, refreshing: false, stale: previous.value !== null, error }));
        })
        .finally(() => {
          busy = false;
          if (controller === nextController) controller = null;
          if (queued && active && (mode !== 'LIVE' || visible())) { queued = false; load(); }
        });
    }
    manualRefresh.current = () => load(true);
    load();
    if (mode !== 'LIVE' && mode !== 'REFERENCE') return () => { active = false; controller?.abort(); manualRefresh.current = null; };
    const timer = window.setInterval(() => load(), 60_000);
    const onVisibility = () => {
      if (!visible()) { queued = false; controller?.abort(); setState(previous => ({ ...previous, refreshing: false })); }
      else load(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { active = false; queued = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); controller?.abort(); manualRefresh.current = null; };
  }, [mode, id, period]);
  useEffect(() => {
    if (lastRefresh.current !== refresh) { lastRefresh.current = refresh; manualRefresh.current?.(); }
  }, [refresh]);
  return state;
}

function ConsumerDiscoveryPage({ refresh }: { refresh: number }) {
  const catalog = useUnifiedCatalog(refresh);
  const [histories, setHistories] = useState<Record<string, MarketHistory>>({});
  useEffect(() => {
    let active = true;
    Promise.allSettled(catalog.markets.map(async market => {
      const history = await consumerRead(market.source.mode).getHistory(market.id, market.source.mode === 'REFERENCE' ? 'ALL' : '1W');
      return history && history.market.id === market.id && history.source.mode === market.source.mode ? history : null;
    })).then(results => {
      if (!active) return;
      setHistories(Object.fromEntries(results.flatMap(result => result.status === 'fulfilled' && result.value ? [[result.value.market.id, result.value]] : [])));
    });
    return () => { active = false; };
  }, [catalog.markets]);
  const markets = [...catalog.markets].sort((a, b) => {
    const rank = (market: ConsumerMarket) => market.source.mode === 'LIVE' ? 0 : market.activity?.historyLabel === 'Daily history' ? 1 : market.activity?.historyLabel ? 2 : 3;
    return rank(a) - rank(b);
  });
  return <MarketDiscovery markets={markets} histories={histories} loading={catalog.loading} liveError={catalog.liveError} onSelectMarket={id => go(marketHref(id))} onRegister={() => go('/register')} />;
}

function ConsumerMarketPage({ id, mode, refresh, changed, transport, section, initialPeriod, actionId }: {
  id: string; mode: ConsumerMode; refresh: number; changed: () => void; transport: Mode | null;
  section: ActionTab; initialPeriod: ConsumerPeriod; actionId: string | null;
}) {
  const [period, setPeriod] = useState<ConsumerPeriod>(initialPeriod);
  const [chartControlsExpanded, setChartControlsExpanded] = useState(false);
  const [failedArtUrl, setFailedArtUrl] = useState<string | null>(null);
  const changePeriod = (next: ConsumerPeriod) => { setPeriod(next); const url = new URL(window.location.href); url.searchParams.set('period', next); window.history.replaceState(null, '', url.pathname + url.search); };
  const history = useConsumerHistory(mode, id, period, refresh);
  const measurementMarket = useData(() => mode === 'LIVE' ? api.getMarket(id) : Promise.resolve({ data: null }), [mode, id, refresh]);
  const validHistory = history.value && history.value.source.mode === mode && history.value.market.source.mode === mode && history.value.market.id === id;
  const selected = history.value?.actions.find(action => action.id === actionId) ?? null;
  const liveId = history.value?.market.liveMarketId ?? id;
  const artSrc = artworkSource(history.value?.market.thumbnailUrl, failedArtUrl);
  const preferredSeriesKind: ConsumerSeriesKind | undefined = mode === 'REFERENCE' ? undefined : section === 'call' ? 'ATTENTION_INDEX' : section === 'trade' ? history.value?.series.some(series => series.kind === 'CURVE_PRICE' && series.points.length) ? 'CURVE_PRICE' : 'REFERENCE_PRICE' : 'REFERENCE_PRICE';
  return <div className="au-consumer-detail au-trading-page">
    <button type="button" className="back" onClick={() => go('/markets')}>← Explore</button>
    {history.loading ? <p className="muted">Loading market history…</p> : history.error && !history.value ? <ErrorBox message={history.error} /> : !history.value ? <Empty title="Market not found" /> : !validHistory ? <ErrorBox message="Market history identity or mode does not match this route." /> : <>
      {history.stale && <Notice tone="orange">Live chart update failed. {history.value.period !== period ? `Showing the previous ${history.value.period} period while ${period} is unavailable. ` : ''}Last successful refresh: {history.refreshedAtMs ? new Date(history.refreshedAtMs).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC' : 'unknown'}. {history.error}</Notice>}
      {history.value.period !== period && !history.refreshing && !history.stale && <Notice tone="orange">Showing the previous {history.value.period} period. The selected {period} period will load when this tab is visible.</Notice>}
      {history.refreshing && <p className="tiny muted" role="status">{history.value.period !== period ? `Loading ${period}; showing ${history.value.period} until it arrives…` : 'Updating live chart…'}</p>}
      <div className="au-detail-heading">{artSrc && <img className="au-detail-art" src={artSrc} alt={history.value.market.imageAlt ?? `${history.value.market.title} artwork`} onError={() => setFailedArtUrl(artSrc)} />}<span className="eyebrow blue-text">{mode === 'REFERENCE' ? 'PUBLIC SOURCE' : 'MARKET'}</span><h1>{marketDisplayTitle(history.value.market.title)}<span className="title-dot">.</span></h1><p>{history.value.market.creatorLabel && `${history.value.market.creatorLabel} · `}{marketDisplaySubtitle(history.value.market)}</p>{history.value.market.subjectUrl && <a className="text-link" href={history.value.market.subjectUrl} target="_blank" rel="noopener noreferrer">View original ↗</a>}</div>
      {selected && <div className="au-selected-action"><strong>{selected.kind === 'CALL_OPEN' ? 'Placed a chip' : selected.kind === 'CALL_CLOSE' ? 'Took back a chip' : selected.kind}</strong><span> · {selected.actorLabel}</span>{selected.note && <SocialNote note={selected.note} />}<button type="button" onClick={() => go(actorHref(selected.actorId, selected.id))}>View profile ↗</button></div>}
      <div className={`au-trading-workspace${section === 'call' ? ' au-chips-workspace' : ''}`}>
        <div className={`au-trading-chart${chartControlsExpanded ? ' au-chart-controls-expanded' : ' au-chart-controls-compact'}`}><button type="button" className="au-mobile-chart-controls" aria-expanded={chartControlsExpanded} onClick={() => setChartControlsExpanded(value => !value)}>{chartControlsExpanded ? 'Compact chart' : 'Chart controls'} <span aria-hidden="true">{chartControlsExpanded ? '−' : '+'}</span></button><ConsumerChart history={history.value} marketContext={measurementMarket.value?.id === id ? measurementMarket.value : null} preferredSeriesKind={preferredSeriesKind} onPeriodChange={changePeriod} onSelectAction={action => go(actorHref(action.actorId, action.id))} actorHref={id => actorHref(id)} recordHref={recordId => `/records/${encodeURIComponent(recordId)}`} noteHref={action => actorHref(action.actorId, action.id)} /></div>
        <div className="au-trading-actions">{mode === 'REFERENCE' ? <ReferenceMarketActions section={section} onChange={tab => go(`${marketHref(id)}${tab === 'call' ? '' : `/${tab === 'liquidity' ? 'lp' : tab}`}`)} /> : liveId !== id ? <ErrorBox message="Market execution identity does not match this chart." /> : <><ActionTabs value={section} onChange={tab => go(`${marketHref(id)}${tab === 'call' ? '' : `/${tab === 'liquidity' ? 'lp' : tab}`}`)} /><MarketPage id={liveId} refresh={refresh} changed={changed} mode={transport} section={section} compact /></>}</div>
      </div>
    </>}
  </div>;
}

function ConsumerLeaderboardPage({ refresh }: { refresh: number }) {
  const [period, setPeriod] = useState<'7D' | 'ALL'>('7D');
  const live = useData(() => consumerData(() => consumerRead('LIVE').getLeaderboard(period)), [period, refresh]);
  return <div className="au-consumer-social-page"><div className="segmented"><button className={period === '7D' ? 'active' : ''} onClick={() => setPeriod('7D')}>7 days</button><button className={period === 'ALL' ? 'active' : ''} onClick={() => setPeriod('ALL')}>All time</button></div><section aria-label="Devnet leaderboard">{live.loading ? <p className="muted">Loading leaderboard…</p> : live.error ? <ErrorBox message={`Leaderboard unavailable. ${live.error}`} /> : live.value && <SocialLeaderboard renderAvatar={renderAvatar} board={live.value} onOpenProfile={id => go(actorHref(id))} />}</section></div>;
}

function ConsumerNoteHistory({ actionId }: { actionId: string }) {
  const result = useData(() => consumerData(() => liveConsumerHttp ? liveConsumerHttp.getNote(actionId) : Promise.reject(new Error('Live notes are unavailable.'))), [actionId]);
  return result.loading ? <p className="muted">Loading note history…</p> : result.error ? <ErrorBox message={result.error} /> : result.value ? <SocialNoteHistory revisions={result.value.revisions} /> : null;
}

function ConsumerProfilePage({ actorId, mode, refresh, changed, own = false, selectedActionId }: {
  actorId: string; mode: ConsumerMode; refresh: number; changed: () => void; own?: boolean; selectedActionId: string | null;
}) {
  const connected = useConnectedWallet(walletClient);
  const wallet = connected?.account.address ?? null;
  const profile = useData(() => consumerData(() => consumerRead(mode).getProfile(actorId)), [actorId, mode, refresh]);
  const markets = useData(() => consumerData(() => consumerRead(mode).listMarkets()), [mode]);
  const [showHistory, setShowHistory] = useState(false);
  const selected = profile.value?.actions.find(action => action.id === selectedActionId) ?? null;
  const names = new Map(markets.value?.map(market => [market.id, market.title]) ?? []);
  const marketMedia = Object.fromEntries((markets.value ?? []).map(market => [market.id, {
    title: market.title, subtitle: market.creatorLabel ?? market.subtitle,
    thumbnailUrl: market.thumbnailUrl, imageAlt: market.imageAlt,
  }]));
  const writer = { save: async (actionId: string, body: string, expectedVersion: number): Promise<ConsumerNote> => {
    const context = currentWalletContext();
    if (mode !== 'LIVE' || !liveFreeFlow || !liveConsumerHttp || !context || context.address !== actorId || context.cluster !== 'devnet') throw new Error('Connect the owning Devnet wallet to edit this note.');
    const session = await liveFreeFlow.authorize(context);
    const fresh = currentWalletContext();
    if (!fresh || fresh.address !== actorId || fresh.cluster !== context.cluster || fresh.signer !== context.signer) throw new Error('Wallet changed before saving the note.');
    return liveConsumerHttp.saveNote(actionId, actorId, body, expectedVersion, session.token);
  } };
  return <div className="au-consumer-social-page">{own && <h1>My activity</h1>}
    {profile.loading ? <p className="muted">Loading profile…</p> : profile.error ? <ErrorBox message={profile.error} /> : !profile.value ? <Empty title="Profile not found" /> : <>
      {selected && <div className="au-selected-action"><strong>{selected.kind === 'CALL_OPEN' ? 'Placed a chip' : 'Took back a chip'} · {names.get(selected.marketId) ?? selected.marketId}</strong><button type="button" onClick={() => go(chartHref(selected))}>See chip on chart ↗</button>{selected.note ? <SocialNote note={selected.note} showHistory={mode === 'LIVE' && selected.note.version > 1 ? () => setShowHistory(value => !value) : undefined} /> : <p>No note for this chip yet.</p>}{showHistory && mode === 'LIVE' && <ConsumerNoteHistory actionId={selected.id} />}</div>}
      <SocialProfile marketMedia={marketMedia} renderAvatar={renderAvatar} renderSubjectImage={renderSubjectImage} profile={profile.value} marketLabel={id => names.get(id) ?? id} onOpenMarket={id => go(marketHref(id))} onOpenAction={action => go(chartHref(action))} onOpenProfile={id => go(actorHref(id))} noteEditor={mode === 'LIVE' && wallet === actorId ? action => <SocialNoteEditor key={action.id} action={action} wallet={wallet} writer={writer} onSaved={changed} /> : undefined} />
      {mode === 'LIVE' && <div className="au-record-links"><h3>Chip records and proofs</h3>{[...new Set(profile.value.actions.map(action => action.recordId).filter((id): id is string => !!id))].map(id => <Link key={id} to={`/records/${encodeURIComponent(id)}`}>{id} ↗</Link>)}</div>}
      {own && mode === 'LIVE' && <><Link to="/me/records" className="text-link">Detailed chip records and private positions ↗</Link><PrivateFinancialPanel wallet={actorId} refresh={refresh} /></>}
    </>}
  </div>;
}

export default function App() {
  const location = usePath();
  const [path, query = ''] = location.split('?');
  const params = new URLSearchParams(query);
  const segment = path.split('/').filter(Boolean);
  const id = decodeRouteId(segment[1]);
  const consumerMode: ConsumerMode = id && isReferenceConsumerId(id) ? 'REFERENCE' : 'LIVE';
  const [transport, setTransport] = useState(transportMode());
  useEffect(() => { const update = () => setTransport(transportMode()); window.addEventListener('ante-up-mode', update); return () => window.removeEventListener('ante-up-mode', update); }, []);
  const [refresh, setRefresh] = useState(0);
  const changed = () => setRefresh((value) => value + 1);
  const route: ConsumerRoute = segment[0] === 'docs' ? 'docs' : path === '/leaderboard' ? 'leaderboard' : path === '/faucet' || path === '/register' ? 'funds' : path === '/me' || segment[0] === 'u' || segment[0] === 'records' || segment[0] === 'proofs' ? 'activity' : 'discover';
  let content: ReactNode;
  if (!segment.length || path === '/markets') content = <ConsumerDiscoveryPage refresh={refresh} />;
  else if (segment[0] === 'markets' && id && !id.startsWith('demo:')) content = <ConsumerMarketPage key={`${consumerMode}:${id}`} id={id} mode={consumerMode} refresh={refresh} changed={changed} transport={transport} section={segment[2] === 'trade' ? 'trade' : segment[2] === 'pro' ? 'pro' : segment[2] === 'lp' ? 'liquidity' : 'call'} initialPeriod={params.get('period') === '1D' || params.get('period') === '1W' || params.get('period') === '1M' ? params.get('period') as ConsumerPeriod : 'ALL'} actionId={params.get('action')} />;
  else if (path === '/faucet') content = <FinancialFaucet onFinalized={changed} />;
  else if (path === '/register') content = <FinancialRegistration onFinalized={changed} />;
  else if (path === '/me/records') content = <WalletProfile>{wallet => wallet ? <ProfilePage wallet={wallet} refresh={refresh} own /> : <div className="page"><Empty title="Wallet not connected" /></div>}</WalletProfile>;
  else if (path === '/me') content = <WalletProfile>{wallet => wallet ? <ConsumerProfilePage key={wallet} actorId={wallet} mode="LIVE" refresh={refresh} changed={changed} own selectedActionId={params.get('action')} /> : <div className="page"><Empty title="Wallet not connected">Connect your wallet to view your activity.</Empty></div>}</WalletProfile>;
  else if (segment[0] === 'u' && id && !id.startsWith('demo:') && !isReferenceConsumerId(id)) content = <ConsumerProfilePage key={`${consumerMode}:${id}`} actorId={id} mode={consumerMode} refresh={refresh} changed={changed} selectedActionId={params.get('action')} />;
  else if (segment[0] === 'records' && id && !id.startsWith('demo:')) content = <RecordPage id={id} />;
  else if (segment[0] === 'proofs' && id && !id.startsWith('demo:')) content = <ProofPage id={id} />;
  else if (path === '/leaderboard') content = <ConsumerLeaderboardPage refresh={refresh} />;
  else if (segment[0] === 'docs') content = <DocsPage slug={segment.length > 2 ? '__not_found__' : segment[1] ? id ?? '__not_found__' : undefined} />;
  else content = <div className="page"><Empty title="Page not found" /></div>;
  return <ConsumerShell route={route} onNavigate={next => go(consumerHref(next))} walletSlot={<WalletPanel />}>{content}</ConsumerShell>;
}
