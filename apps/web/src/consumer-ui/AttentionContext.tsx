import type { MarketView } from '../../../../contracts/types';

const SOLANA_COUNTS_MARKET = '7kmhXsn6GsFf1rZX5jYZ5xtPeProB6Vqtbx4ghUaFJGT';
const SOLANA_QUERY_HASH = 'e90d17a9452f18411f83cec70f7c32e3414770b8aca80ab1b0572ae311aa9c9d';
/** This presentation mapping is scoped to the independently checked collector/query. */
export function attentionContext(market: MarketView | null | undefined) {
  const snapshot = market?.snapshot;
  const knownFormula = snapshot?.finality === 'finalized' && snapshot.payload.marketId === market?.id && snapshot.payload.formulaVersion === 'h3-d7-q12-v1';
  const xCounts = knownFormula && !market?.dataProvenance && market?.id === SOLANA_COUNTS_MARKET && snapshot?.payload.queryVersion === '1' && snapshot.payload.queryHash === SOLANA_QUERY_HASH;
  return { knownFormula, xCounts, synthetic: market?.dataProvenance === 'SYNTHETIC_QA' };
}
export function AttentionContext({ market, observedAtMs }: { market?: MarketView | null; observedAtMs: number | null }) {
  const context = attentionContext(market);
  return <aside className="au-attention-context" aria-label="Attention measurement">
    <strong>{context.xCounts ? 'X post counts · English · excluding reposts' : context.synthetic ? 'Operator-generated inputs' : 'Published attention snapshots'}</strong>
    <p>{context.knownFormula ? 'Activity (3-day EWMA half-life) ÷ its value 7 days earlier. 1× means equal activity.' : 'Source and formula details are not verified for this market.'}</p>
    <p>{observedAtMs !== null ? <>Observed <time dateTime={new Date(observedAtMs).toISOString()}>{new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }).format(observedAtMs)} UTC</time></> : 'Observation time unavailable'} · Chart change: first → last shown.</p>
    <div className="au-attention-links"><a href="/docs/data-pricing#attention-reference">Source &amp; formula</a>{market && <a href={`${import.meta.env.VITE_API_BASE_URL ?? '/api'}/v1/markets/${encodeURIComponent(market.id)}`} target="_blank" rel="noopener noreferrer">Published snapshot ↗</a>}</div>
    <details><summary>Measurement details</summary><p>Chip results compare the index at placement and return. A chart’s period change is a separate comparison.</p>{context.xCounts && <><p>The configured query is ("solana") lang:en -is:retweet. Minute counts are smoothed with a three-day EWMA half-life and compared with the same index exactly seven days earlier.</p><a href="https://docs.x.com/x-api/posts/counts/introduction" target="_blank" rel="noopener noreferrer">X Counts API documentation ↗</a><p>Raw minute-count files are archived by the collector; this public API exposes the published snapshot, not those raw files.</p></>}{market?.snapshot && <p>Formula {market.snapshot.payload.formulaVersion} · Query {market.snapshot.payload.queryVersion} · Devnet</p>}</details>
  </aside>;
}
