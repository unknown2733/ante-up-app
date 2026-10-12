import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { FreeRecord, MarketView, Mode, OpenPreview, ProofStatus, PublicProfile } from '../../../contracts/types';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import { api, isFixture, liveFreeFlow, transportMode } from './api';
import { DEMO_WALLET } from './wallet';
import { currentWalletContext, walletClient, walletCluster, WalletPanel, WalletProfile } from './walletSdk';
import type { FreeOutcome, FreeProgress, FreeRequest } from './liveFree';
import { FinancialFaucet, FinancialMarket, FinancialRegistration, PrivateFinancialPanel } from './Financial';
import { displayConsumerError } from './consumer-ui/copy';
import type { ConsumerAction, ConsumerMarket, ConsumerMode, ConsumerNote, ConsumerPeriod, MarketHistory } from '../../../contracts/consumer';
import { ConsumerShell, MarketDiscovery, ActionTabs, mergeConsumerMarkets } from './consumer-ui';
import type { ActionTab, ConsumerRoute } from './consumer-ui';
import { ConsumerChart } from './charts/ConsumerChart';
import { SocialLeaderboard, SocialNote, SocialNoteEditor, SocialNoteHistory, SocialProfile } from './social/Social';
import { demoConsumerReadApi, liveConsumerHttp } from './api';
import { demoActors } from '../../../contracts/fixtures/consumer/catalog';

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
function ownProfile(): Promise<{ data: PublicProfile | null }> {
  return isFixture ? api.getProfile(DEMO_WALLET) : Promise.resolve({ data: null });
}

const marketName = (id: string) => ({ 'm-attention': 'attention', 'm-meme': 'meme', 'm-outage': 'outage', 'm-signal': 'signal', 'm-wait': 'moment', 'fixture:sol': 'solana', 'fixture:unready': 'unready' })[id as 'm-attention'] || id;
const statusText = { PREPARING: 'Preparing data', VALID: 'Data current', LOW_ACTIVITY: 'Low activity', OUTAGE: 'Data unavailable' };
const phaseText = { CURVE: 'Bonding curve', GRADUATION_WAIT: 'Graduation pending', INDEXED: 'Index market' };
const reasonText: Record<string, string> = { DATA_NOT_READY: 'Preparing data', DATA_STALE: 'Observation delayed', LOW_ACTIVITY: 'New paid trades paused during low activity', WRONG_PHASE: 'Unavailable at this market stage', PENDING_CONFIRMATION: 'Chain connection unavailable', LIMIT_REACHED: 'Limit reached', BUDGET_EXHAUSTED: 'Cost limit reached', STORAGE_BACKLOG: 'Proof storage pending' };
const proofText: Record<ProofStatus['state'], string> = { QUEUED: 'Proof pending', UPLOADED: 'Uploaded to storage', CONFIRMING: 'Confirming storage', READY_TO_ISSUE: 'Ready to issue', ISSUED: 'Proof issued', INVALID: 'Proof invalid', REPLACED: 'Replacement proof available' };
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
function shortWallet(wallet: string) { return wallet === DEMO_WALLET ? 'My demo profile' : wallet.replace('demo:', '@'); }

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
  const running = useRef(false);
  const wallet = currentWalletContext();
  const requestValue: FreeRequest = { market, action: recordId ? 'closeFree' : 'openFree', recordId };
  const unavailable = mode !== walletCluster ? 'The API network does not match your wallet network.' : !liveFreeFlow ? 'Chip placement is unavailable here.' : limitReached && !recordId ? 'You have reached the three active chip limit.' : liveFreeFlow.supportReason(requestValue, wallet);
  useEffect(() => { setProgress(null); setOutcome(liveFreeFlow?.pending(requestValue, currentWalletContext()) ?? null); }, [connected?.account.address, market.id, recordId]);
  async function run() {
    if (!liveFreeFlow || running.current || unavailable || profileLoading) return;
    running.current = true; setBusy(true); setOutcome(null); setProgress('AUTH');
    try {
      const result = await liveFreeFlow.run(requestValue, setProgress);
      setOutcome(result);
      if (result.state === 'FINALIZED') changed();
    } finally { running.current = false; setBusy(false); }
  }
  async function recheck() {
    if (!liveFreeFlow || running.current || !outcome?.requestId) return;
    running.current = true; setBusy(true);
    try {
      const result = await liveFreeFlow.recheck(requestValue, outcome.requestId, outcome.signature);
      setOutcome(result);
      if (result.state === 'FINALIZED') changed();
    } finally { running.current = false; setBusy(false); }
  }
  const pending = outcome?.state === 'UNKNOWN' || outcome?.state === 'CONFIRMED' || outcome?.state === 'SUBMITTED';
  const disabled = busy || profileLoading || !!unavailable || pending || outcome?.state === 'FINALIZED';
  const progressText: Record<FreeProgress, string> = { AUTH: 'Authenticating wallet…', PREPARING: 'Preparing transaction…', AWAITING_SIGNATURE: 'Waiting for wallet signature…', SUBMITTED: 'Submitted · checking finality…', CONFIRMED: 'Confirming on chain…' };
  return <>
    <button className={`button full ${disabled ? 'button-disabled' : 'button-chip'}`} disabled={disabled} onClick={run}>{busy ? progressText[progress ?? 'AUTH'] : recordId ? 'Take back chip' : 'Place chip'} <span>↗</span></button>
    {unavailable && <p className="tiny muted">{displayConsumerError(unavailable)}</p>}
    {outcome && <Notice tone={outcome.state === 'FINALIZED' ? 'blue' : outcome.state === 'FAILED' ? 'red' : 'orange'}>{outcome.state === 'FINALIZED' ? 'Finalized. Refresh your activity to see the record.' : outcome.state === 'UNKNOWN' || outcome.state === 'CONFIRMED' || outcome.state === 'SUBMITTED' ? 'Status is not final. Check this request before trying again.' : displayConsumerError(outcome.reason)}{outcome.requestId && <span className="tiny"> Request ID: {outcome.requestId}</span>}{outcome.signature && <span className="tiny"> · Signature: {outcome.signature}</span>}</Notice>}
    {projectionWaiting && <button className="button button-dark full" disabled={busy || profileLoading} onClick={changed}>Refresh finalized activity</button>}
    {pending && <button className="button button-dark full" disabled={busy || !connected} onClick={recheck}>Check existing request</button>}
  </>;
}

function MarketPage({ id, refresh, changed, mode, section = 'call' }: { id: string; refresh: number; changed: () => void; mode: Mode | null; section?: ActionTab }) {
  const market = useData(() => api.getMarket(id), [id, refresh]);
  const connected = useConnectedWallet(walletClient);
  const walletAddress = connected?.account.address ?? null;
  const [profileRefresh, setProfileRefresh] = useState(0);
  const [, redrawProjection] = useState(0);
  const profile = useData(() => isFixture ? ownProfile() : walletAddress ? api.getProfile(walletAddress) : Promise.resolve({ data: null }), [id, refresh, walletAddress, profileRefresh]);
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
    if (!m) return;
    setBusy(true); setMessage('');
    try {
      const response = open ? await api.closeFree(DEMO_WALLET, open.id) : await api.openFree(DEMO_WALLET, m.id);
      if (response.kind === 'fixture') { changed(); setMessage(open ? 'Sample chip returned. Review its illustrative result.' : 'Sample chip placed. No wallet signature or chain record was created.'); }
      else setMessage(displayConsumerError(response.reason));
    } finally { setBusy(false); }
  }
  if (market.loading) return <div className="page"><p className="muted">Loading markets…</p></div>;
  if (market.error) return <div className="page"><ErrorBox message={market.error} /></div>;
  if (!m) return <div className="page"><Empty title="Market not found" /></div>;
  const freeAllowed = m.capabilities[open ? 'closeFree' : 'openFree'];
  const ownLimit = (profile.value?.openRecords.length || 0) >= 3;
  const duplicate = !open && profile.value?.openRecords.some((record) => record.marketId === m.id);
  return <div className="page">
    <div className="detail-title"><span className="eyebrow blue-text">DEVNET MARKET</span><div className="tag-row"><Tag tone="blue">{phaseText[m.phase]}</Tag><Tag tone={m.dataStatus === 'VALID' ? 'green' : m.dataStatus === 'OUTAGE' ? 'red' : 'orange'}>{statusText[m.dataStatus]}</Tag>{!m.supported && <Tag tone="orange">Data coverage pending</Tag>}</div></div>
    <div className="detail-grid"><div className="metric-card primary-metric"><span className="eyebrow">{m.price?.kind === 'curve' ? 'Curve quote' : 'Index reference'}</span><strong>{m.price ? atoms(m.price.atoms) : '—'}<small>{m.price ? ' tUSD' : ''}</small></strong><p>{isFixture ? 'Demo reference · not an execution price' : m.price?.executable ? 'Published snapshot · rechecked at execution' : 'Reference only · unavailable for execution'}</p></div><div className="metric-card"><span className="eyebrow">Fixed price cap</span><strong>{m.anchor ? `${atoms(m.anchor.maxPriceAtoms)} tUSD` : '—'}</strong><p>{m.anchor ? 'Graduation anchor' : 'Before graduation / no anchor'}</p></div></div>
    {m.snapshot && <div className="snapshot-strip"><span>Observed {date(m.snapshot.payload.dataThrough)}</span><span>Formula {m.snapshot.payload.formulaVersion}</span><span>Query {m.snapshot.payload.queryHash.slice(0, 8)}…</span><Tag tone={m.snapshot.payload.admission.state === 'OPEN' ? 'green' : 'orange'}>{m.snapshot.payload.admission.state === 'OPEN' ? 'New entries open' : m.snapshot.payload.admission.state === 'RECOVERING' ? `Recovery checks ${m.snapshot.payload.admission.recoveryCount}/2` : 'New entries paused'}</Tag></div>}
    <div className="comparison-strip"><div><span>Attention change since chip placement</span><strong>{open ? 'Chip active' : 'See activity'}</strong></div><div><span>Weekly price change</span><strong>No data</strong></div><div><span>My trade P&L</span><strong>No P&L data</strong></div></div>
    {section === 'call' && <section className="detail-panel"><div className="section-head"><div><span className="eyebrow orange-text">CHIPS</span><h2>{open ? 'Your chip is active' : 'Place a chip'}</h2></div><span className="au-chip-count" aria-label={`${profile.value?.openRecords.length ?? 'Unknown'} of 3 active chips`}><span aria-hidden="true">◉</span> {profile.value?.openRecords.length ?? '—'} / 3 active</span></div><p>{open ? 'Take back your chip to finalize the attention result and free up this chip.' : 'Place a chip on this keyword and take it back later. The result tracks attention change, not a cash payout.'}</p>
      <div className="rule-list"><div><span>Active chips</span><strong>{profile.value?.openRecords.length ?? '—'} / 3</strong></div><div><span>Per market</span><strong>Maximum one</strong></div><div><span>New placements</span><strong>6 per wallet / 24 h · 100 total</strong></div></div>
      {m.dataStatus === 'LOW_ACTIVITY' && <Notice tone="orange">Activity is low. Chips remain available; new paid trades are paused.</Notice>}
      {m.dataStatus === 'OUTAGE' && <Notice tone="red">You can still place or take back a chip while data is unavailable. Taking it back now may record N/A.</Notice>}
      {m.dataStatus === 'PREPARING' && <Notice tone="orange">The index is preparing. A missing entry reference will not be backfilled.</Notice>}
      {message && <Notice tone="blue">{message}</Notice>}
      {!isFixture && profile.error && <Notice tone="red">Could not verify your active chips, so another action is blocked. {profile.error}</Notice>}
      {isFixture ? <button className="button button-chip full" disabled={busy || freeAllowed?.allowed === false || (!!ownLimit && !open) || !!duplicate} onClick={mutate}>{busy ? 'Processing…' : open ? 'Take back chip' : 'Place chip'} <span>↗</span></button> : <LiveFreeAction market={m} recordId={open?.id ?? null} mode={mode} profileLoading={profile.loading || !!profile.error} limitReached={ownLimit} projectionWaiting={!!projectionWait} changed={changed} />}
      {(freeAllowed?.allowed === false || (ownLimit && !open)) && <p className="tiny muted">{ownLimit && !open ? 'You have reached the three active chip limit.' : reasonText[freeAllowed?.reason || ''] || displayConsumerError(freeAllowed?.reason)}</p>}
      <p className="tiny muted">{isFixture ? 'This changes a browser-only sample record. It does not submit a transaction or issue proof.' : 'Devnet actions require wallet signature, entry approval, and final chain confirmation.'}</p>
      {open && <RecordCard record={open} compact />}
    </section>}
    {section !== 'call' && <><Link to="/faucet" className="text-link">Get test tUSD ↗</Link><FinancialMarket key={`${m.id}:${section}`} market={m} section={section === 'trade' ? 'money' : section === 'liquidity' ? 'lp' : 'pro'} onFinalized={changed} /></>}
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
  const result = r.result?.kind === 'return' ? percent(r.result) : r.status === 'CLOSED_NA' ? 'N/A' : 'Open';
  return <div className="page"><Link to={r.wallet === DEMO_WALLET || r.wallet === connected?.account.address ? '/me' : `/u/${encodeURIComponent(r.wallet)}`} className="back">← Profile</Link><div className="profile-header"><span className="eyebrow blue-text">CHIP RECORD / {r.id}</span><h1>{market.value?.keyword ?? marketName(r.marketId)}<span className="title-dot">.</span></h1><p>Chip participation · separate from paid trades</p></div>
    {r.status === 'OPEN' && <Link to={`/markets/${encodeURIComponent(r.marketId)}`} className="button button-chip full">{r.wallet === connected?.account.address || isFixture ? 'Go to take back chip' : 'View market'} ↗</Link>}
    <div className="result-hero"><span className="eyebrow">Attention change since chip placement</span><strong className={r.result?.kind === 'return' && Number(r.result.numerator) < 0 ? 'red' : ''}>{result}</strong><p>{r.result?.kind === 'na' ? displayConsumerError(r.result.reason) : r.status === 'OPEN' ? 'Before taking back · reference result is excluded from ranking' : 'Fixed when taken back · separate from weekly price change and trade P&L'}</p></div>
    <div className="timeline"><div><span className="timeline-dot" /><span>Placed a chip</span><strong>{date(r.entry.executedAt)}</strong><small>slot {r.entry.slot} · {r.entry.h ? `h ${r.entry.h.numerator}/${r.entry.h.denominator}` : r.entry.unavailableReason ? displayConsumerError(r.entry.unavailableReason) : 'No index reference'}</small></div><div><span className="timeline-dot" /><span>Took back a chip</span><strong>{r.exit ? date(r.exit.executedAt) : 'Still active'}</strong><small>{r.exit ? `slot ${r.exit.slot} · ${r.exit.h ? `h ${r.exit.h.numerator}/${r.exit.h.denominator}` : r.exit.unavailableReason ? displayConsumerError(r.exit.unavailableReason) : 'No index reference'}` : 'There is no weekly forced close'}</small></div></div>
    <section className="detail-panel proof-panel"><span className="eyebrow orange-text">VERIFY THE CHIP</span><h2>Record and proof status</h2>{r.status === 'OPEN' ? <Notice tone="blue">An active chip has an entry record. Result proof is issued separately after it is taken back.</Notice> : proof.loading ? <p className="muted">Loading proof status…</p> : proof.error ? <ErrorBox message={proof.error} /> : p ? <><div className="proof-state"><Tag tone={p.state === 'ISSUED' ? 'green' : p.state === 'INVALID' || p.state === 'REPLACED' ? 'red' : 'orange'}>{proofText[p.state]}</Tag><span>{p.confirmations === null ? 'Confirmations unavailable' : `Storage transaction ${p.confirmations}/20 confirmations`}</span></div>{p.error && <Notice tone={p.state === 'INVALID' || p.state === 'REPLACED' ? 'red' : 'orange'}>{displayConsumerError(p.error)}</Notice>}{p.replacementId && <Link to={`/proofs/${encodeURIComponent(p.replacementId)}`} className="text-link">Replacement proof {p.replacementId} ↗</Link>}<div className="proof-facts"><div><span>Content hash</span><code>{p.payloadHash ? `${p.payloadHash.slice(0, 12)}…` : 'Pending'}</code></div><div><span>Manifest</span><strong>{p.manifestRef?.arweaveItemId || 'Pending storage'}</strong></div><div><span>SAS ID</span><strong>{p.sasId || 'Not issued'}</strong></div><div><span>Source evidence</span><strong>{p.evidence[0]?.arweaveItemId || 'Pending storage'}</strong></div></div></> : <Notice tone="orange">The close is recorded while proof is pending. The result and slot release are separate from proof issuance.</Notice>}
      <p className="tiny muted">{isFixture ? 'Sample hashes, transactions, and SAS IDs are examples, not verifiable external links. ' : ''}Result proof is issued only after evidence storage, inclusion, and 20-confirmation checks.</p></section>
    <div className="record-footer"><Link to={`/u/${encodeURIComponent(r.wallet)}`} className="text-link">View public profile ↗</Link><span className="tiny muted">Shared cards are snapshots of the record</span></div>
  </div>;
}

function ProofPage({ id }: { id: string }) {
  const proof = useData(() => api.getProof(id), [id]);
  return <div className="page"><Link to="/markets" className="back">← Markets</Link><div className="profile-header"><span className="eyebrow blue-text">PROOF HISTORY</span><h1>Proof history<span className="title-dot">.</span></h1></div>{proof.loading ? <p>Loading…</p> : proof.error ? <ErrorBox message={proof.error} /> : proof.value ? <div className="detail-panel"><h2>{proofText[proof.value.state]}</h2><p>{proof.value.error ? displayConsumerError(proof.value.error) : 'Proof status for this record.'}</p><div className="proof-facts"><div><span>Proof ID</span><strong>{proof.value.id}</strong></div><div><span>Source record</span><Link to={`/records/${encodeURIComponent(proof.value.recordId)}`} className="text-link">{proof.value.recordId} ↗</Link></div><div><span>Content hash</span><code>{proof.value.payloadHash ? `${proof.value.payloadHash.slice(0, 12)}…` : 'Pending'}</code></div><div><span>Manifest</span><strong>{proof.value.manifestRef?.arweaveItemId || 'Pending storage'}</strong></div><div><span>SAS ID</span><strong>{proof.value.sasId || 'Not issued'}</strong></div></div>{proof.value.replacementId && <Link to={`/proofs/${encodeURIComponent(proof.value.replacementId)}`} className="text-link">View replacement proof ↗</Link>}</div> : <Empty title="Proof not found" />}</div>;
}

const consumerHref = (route: ConsumerRoute) => route === 'discover' ? '/markets' : route === 'activity' ? '/me' : route === 'funds' ? '/faucet' : route === 'docs' ? '/docs' : '/leaderboard';
const marketHref = (id: string) => `/markets/${encodeURIComponent(id)}`;
const actorHref = (id: string, actionId?: string) => `/u/${encodeURIComponent(id)}${actionId ? `?action=${encodeURIComponent(actionId)}` : ''}`;
const chartHref = (action: ConsumerAction) => `${marketHref(action.marketId)}?period=ALL&action=${encodeURIComponent(action.id)}`;
function consumerRead(mode: ConsumerMode) {
  if (mode === 'DEMO') return demoConsumerReadApi;
  if (!liveConsumerHttp) throw new Error('Live Devnet markets are unavailable. Configure the API connection to view them.');
  return liveConsumerHttp.read;
}
function consumerData<T>(load: () => Promise<T>) { return Promise.resolve().then(load).then(data => ({ data })); }
function decodeRouteId(value: string | undefined) { try { return value ? decodeURIComponent(value) : null; } catch { return null; } }

interface CatalogState { markets: ConsumerMarket[]; liveError: string; loading: boolean }
function useUnifiedCatalog(refresh: number): CatalogState {
  const [state, setState] = useState<CatalogState>({ markets: [], liveError: '', loading: true });
  useEffect(() => {
    let active = true;
    setState(previous => ({ ...previous, loading: true }));
    Promise.allSettled([demoConsumerReadApi.listMarkets(), liveConsumerHttp ? liveConsumerHttp.read.listMarkets() : Promise.reject(new Error('Devnet API is not configured.'))]).then(results => {
      if (!active) return;
      const samples = results[0].status === 'fulfilled' ? results[0].value : [];
      const live = results[1].status === 'fulfilled' ? results[1].value : [];
      const liveError = results[1].status === 'rejected' ? displayConsumerError(results[1].reason instanceof Error ? results[1].reason.message : null, 'Devnet markets are unavailable.') : '';
      setState({ markets: mergeConsumerMarkets(samples, live), liveError, loading: false });
    });
    return () => { active = false; };
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
      Promise.resolve().then(() => mode === 'DEMO'
        ? demoConsumerReadApi.getHistory(id, period)
        : liveConsumerHttp ? liveConsumerHttp.getHistory(id, period, nextController.signal) : Promise.reject(new Error('Live Devnet markets are unavailable.')))
        .then(value => {
          if (value && (value.market.id !== id || value.period !== period || value.source.mode !== mode || value.market.source.mode !== mode || (mode === 'LIVE' && value.market.liveMarketId && value.market.liveMarketId !== id))) throw new Error('Market history identity or mode does not match this route.');
          if (active && !nextController.signal.aborted) setState({ value, loading: false, refreshing: false, stale: false, error: '', refreshedAtMs: Date.now() });
        })
        .catch(reason => {
          if (!active || nextController.signal.aborted) return;
          const error = displayConsumerError(reason instanceof Error ? reason.message : null, 'Could not refresh market history.');
          setState(previous => ({ ...previous, loading: false, refreshing: false, stale: previous.value !== null, error }));
        })
        .finally(() => {
          busy = false;
          if (controller === nextController) controller = null;
          if (queued && active && (mode === 'DEMO' || visible())) { queued = false; load(); }
        });
    }
    manualRefresh.current = () => load(true);
    load();
    if (mode !== 'LIVE') return () => { active = false; controller?.abort(); manualRefresh.current = null; };
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
  return <MarketDiscovery markets={catalog.markets} loading={catalog.loading} liveError={catalog.liveError} onSelectMarket={id => go(marketHref(id))} onRegister={() => go('/register')} />;
}

function ConsumerMarketPage({ id, mode, refresh, changed, transport, section, initialPeriod, actionId }: {
  id: string; mode: ConsumerMode; refresh: number; changed: () => void; transport: Mode | null;
  section: ActionTab; initialPeriod: ConsumerPeriod; actionId: string | null;
}) {
  const [period, setPeriod] = useState<ConsumerPeriod>(initialPeriod);
  const [artFailed, setArtFailed] = useState(false);
  const changePeriod = (next: ConsumerPeriod) => { setPeriod(next); const url = new URL(window.location.href); url.searchParams.set('period', next); window.history.replaceState(null, '', url.pathname + url.search); };
  const history = useConsumerHistory(mode, id, period, refresh);
  const validHistory = history.value && history.value.source.mode === mode && history.value.market.source.mode === mode && history.value.market.id === id;
  const selected = history.value?.actions.find(action => action.id === actionId) ?? null;
  const liveId = history.value?.market.liveMarketId ?? id;
  return <div className="au-consumer-detail">
    <button type="button" className="back" onClick={() => go('/markets')}>← Explore</button>
    {history.loading ? <p className="muted">Loading market history…</p> : history.error && !history.value ? <ErrorBox message={history.error} /> : !history.value ? <Empty title="Market not found" /> : !validHistory ? <ErrorBox message="Market history identity or mode does not match this route." /> : <>
      {history.stale && <Notice tone="orange">Live chart update failed. {history.value.period !== period ? `Showing the previous ${history.value.period} period while ${period} is unavailable. ` : ''}Last successful refresh: {history.refreshedAtMs ? new Date(history.refreshedAtMs).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC' : 'unknown'}. {history.error}</Notice>}
      {history.value.period !== period && !history.refreshing && !history.stale && <Notice tone="orange">Showing the previous {history.value.period} period. The selected {period} period will load when this tab is visible.</Notice>}
      {history.refreshing && <p className="tiny muted" role="status">{history.value.period !== period ? `Loading ${period}; showing ${history.value.period} until it arrives…` : 'Updating live chart…'}</p>}
      <div className="au-detail-heading">{history.value.market.thumbnailUrl && !artFailed && <img className="au-detail-art" src={history.value.market.thumbnailUrl} alt={history.value.market.imageAlt ?? `${history.value.market.title} artwork`} onError={() => setArtFailed(true)} />}<span className="eyebrow blue-text">{mode === 'DEMO' ? 'REAL SUBJECT · SAMPLE HISTORY' : 'DEVNET OBSERVED MARKET'}</span><h1>{history.value.market.title}<span className="title-dot">.</span></h1><p>{history.value.market.creatorLabel && `${history.value.market.creatorLabel} · `}{history.value.market.subtitle}</p>{history.value.market.subjectUrl && <a className="text-link" href={history.value.market.subjectUrl} target="_blank" rel="noopener noreferrer">Open official subject ↗</a>}</div>
      {selected && <div className="au-selected-action"><strong>{selected.kind === 'CALL_OPEN' ? 'Placed a chip' : selected.kind === 'CALL_CLOSE' ? 'Took back a chip' : selected.kind}</strong><span> · {selected.actorLabel}</span>{selected.note && <SocialNote note={selected.note} />}<button type="button" onClick={() => go(actorHref(selected.actorId, selected.id))}>View profile ↗</button></div>}
      <ConsumerChart history={history.value} onPeriodChange={changePeriod} onSelectAction={action => go(actorHref(action.actorId, action.id))} actorHref={id => actorHref(id)} recordHref={recordId => mode === 'DEMO' ? actorHref(history.value!.actions.find(action => action.recordId === recordId)?.actorId ?? '', history.value!.actions.find(action => action.recordId === recordId)?.id) : `/records/${encodeURIComponent(recordId)}`} noteHref={action => actorHref(action.actorId, action.id)} />
      {mode === 'DEMO' ? <Notice tone="orange">Sample history and example activity are illustrative. This subject has no connected Devnet market, wallet action, trade, or proof.</Notice> : liveId !== id ? <ErrorBox message="Market execution identity does not match this chart." /> : <><ActionTabs value={section} onChange={tab => go(`${marketHref(id)}${tab === 'call' ? '' : `/${tab === 'liquidity' ? 'lp' : tab}`}`)} /><MarketPage id={liveId} refresh={refresh} changed={changed} mode={transport} section={section} /></>}
    </>}
  </div>;
}

function ConsumerLeaderboardPage({ refresh }: { refresh: number }) {
  const [period, setPeriod] = useState<'7D' | 'ALL'>('7D');
  const live = useData(() => consumerData(() => consumerRead('LIVE').getLeaderboard(period)), [period, refresh]);
  const sample = useData(() => consumerData(() => demoConsumerReadApi.getLeaderboard(period)), [period]);
  return <div className="au-consumer-social-page"><div className="segmented"><button className={period === '7D' ? 'active' : ''} onClick={() => setPeriod('7D')}>7 days</button><button className={period === 'ALL' ? 'active' : ''} onClick={() => setPeriod('ALL')}>All time</button></div><section aria-label="Devnet leaderboard">{live.loading ? <p className="muted">Loading Devnet leaderboard…</p> : live.error ? <ErrorBox message={`Devnet leaderboard unavailable. ${live.error}`} /> : live.value && <SocialLeaderboard board={live.value} onOpenProfile={id => go(actorHref(id))} />}</section><section className="au-sample-board" aria-label="Example leaderboard"><h2>Example leaderboard</h2><p>Illustrative rankings from sample histories. No real wallets or Devnet results are included.</p>{sample.loading ? <p className="muted">Loading examples…</p> : sample.error ? <ErrorBox message={sample.error} /> : sample.value && <SocialLeaderboard board={sample.value} onOpenProfile={id => go(actorHref(id))} />}</section></div>;
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
      <SocialProfile profile={profile.value} marketLabel={id => names.get(id) ?? id} onOpenMarket={id => go(marketHref(id))} onOpenAction={action => go(chartHref(action))} onOpenProfile={id => go(actorHref(id))} noteEditor={mode === 'LIVE' && wallet === actorId ? action => <SocialNoteEditor key={action.id} action={action} wallet={wallet} writer={writer} onSaved={changed} /> : undefined} />
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
  const consumerMode: ConsumerMode = id?.startsWith('demo:') || (path === '/me' && params.get('mode') === 'demo') ? 'DEMO' : 'LIVE';
  const [transport, setTransport] = useState(transportMode());
  useEffect(() => { const update = () => setTransport(transportMode()); window.addEventListener('ante-up-mode', update); return () => window.removeEventListener('ante-up-mode', update); }, []);
  const [refresh, setRefresh] = useState(0);
  const changed = () => setRefresh((value) => value + 1);
  const route: ConsumerRoute = segment[0] === 'docs' ? 'docs' : path === '/leaderboard' ? 'leaderboard' : path === '/faucet' || path === '/register' ? 'funds' : path === '/me' || segment[0] === 'u' || segment[0] === 'records' || segment[0] === 'proofs' ? 'activity' : 'discover';
  let content: ReactNode;
  if (!segment.length || path === '/markets') content = <ConsumerDiscoveryPage refresh={refresh} />;
  else if (segment[0] === 'markets' && id) content = <ConsumerMarketPage key={`${consumerMode}:${id}`} id={id} mode={consumerMode} refresh={refresh} changed={changed} transport={transport} section={segment[2] === 'trade' ? 'trade' : segment[2] === 'pro' ? 'pro' : segment[2] === 'lp' ? 'liquidity' : 'call'} initialPeriod={params.get('period') === '1D' || params.get('period') === '1W' || params.get('period') === '1M' ? params.get('period') as ConsumerPeriod : 'ALL'} actionId={params.get('action')} />;
  else if (path === '/faucet') content = <FinancialFaucet onFinalized={changed} />;
  else if (path === '/register') content = <FinancialRegistration onFinalized={changed} />;
  else if (path === '/me/records') content = <WalletProfile>{wallet => wallet ? <ProfilePage wallet={wallet} refresh={refresh} own /> : <div className="page"><Empty title="Wallet not connected" /></div>}</WalletProfile>;
  else if (path === '/me') content = consumerMode === 'DEMO' ? <ConsumerProfilePage key="demo-own" actorId={demoActors[0].id} mode="DEMO" refresh={refresh} changed={changed} own selectedActionId={params.get('action')} /> : <WalletProfile>{wallet => wallet ? <ConsumerProfilePage key={wallet} actorId={wallet} mode="LIVE" refresh={refresh} changed={changed} own selectedActionId={params.get('action')} /> : <div className="page"><Empty title="Wallet not connected">Connect a Devnet wallet to view your activity.</Empty></div>}</WalletProfile>;
  else if (segment[0] === 'u' && id) content = <ConsumerProfilePage key={`${consumerMode}:${id}`} actorId={id} mode={consumerMode} refresh={refresh} changed={changed} selectedActionId={params.get('action')} />;
  else if (segment[0] === 'records' && id && !id.startsWith('demo:')) content = <RecordPage id={id} />;
  else if (segment[0] === 'proofs' && id && !id.startsWith('demo:')) content = <ProofPage id={id} />;
  else if (path === '/leaderboard') content = <ConsumerLeaderboardPage refresh={refresh} />;
  else if (segment[0] === 'docs') content = <div className="page"><Empty title="Docs are being prepared">Guides will be available here after the Docs module is integrated.</Empty></div>;
  else content = <div className="page"><Empty title="Page not found" /></div>;
  return <ConsumerShell route={route} onNavigate={next => go(consumerHref(next))} walletSlot={<WalletPanel />}>{content}</ConsumerShell>;
}
