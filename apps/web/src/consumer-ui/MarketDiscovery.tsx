import { useMemo, useState } from 'react';
import type { ConsumerMarket, ConsumerSubject, MarketHistory } from '../../../../contracts/consumer';
import { consumerCopy, formatDisplayPrice } from './copy';
import { EmptyState, MarketStatus, SubjectGlyph } from './controls';
import { artworkSource } from './artwork';
import { MarketSparkline } from './MarketSparkline';

export interface MarketDiscoveryProps {
  markets: ConsumerMarket[];
  histories?: Record<string, MarketHistory>;
  loading?: boolean;
  liveError?: string | null;
  onSelectMarket: (marketId: string) => void;
  onRegister?: () => void;
}

const subjects: Array<ConsumerSubject | 'ALL'> = ['ALL', 'KEYWORD', 'POST', 'VIDEO', 'TRACK', 'ALBUM', 'ACCOUNT'];

function MarketArtwork({ market }: { market: ConsumerMarket }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const src = artworkSource(market.thumbnailUrl, failedUrl);
  return src
    ? <img className="au-market-art" src={src} alt={market.imageAlt ?? `${market.title} artwork`} loading="lazy" onError={() => setFailedUrl(src)} />
    : <SubjectGlyph subject={market.subject} />;
}

export function MarketDiscovery({ markets, histories, loading = false, liveError, onSelectMarket, onRegister }: MarketDiscoveryProps) {
  const [query, setQuery] = useState('');
  const [subject, setSubject] = useState<ConsumerSubject | 'ALL'>('ALL');
  const visible = useMemo(() => markets.filter(market =>
    (subject === 'ALL' || market.subject === subject) &&
    `${market.title} ${market.subtitle} ${market.creatorLabel ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [markets, subject, query]);
  return <section className="au-discovery" aria-labelledby="au-discovery-title">
    <div className="au-page-heading"><div><p className="au-kicker">EXPLORE / WHAT'S MOVING</p><h1 id="au-discovery-title">Explore<span>.</span></h1><p>Find a subject, place a chip where available, and follow its movement.</p></div>{onRegister && <button type="button" className="au-text-action" onClick={onRegister}>Register a keyword <span aria-hidden="true">↗</span></button>}</div>
    {liveError && <div className="au-live-warning" role="alert"><strong>Devnet markets could not be loaded.</strong><span>{liveError} Public-source subjects remain available below.</span></div>}
    <div className="au-discovery-tools"><label className="au-search"><span aria-hidden="true">⌕</span><span className="au-sr-only">Search subjects</span><input type="search" placeholder="Search subjects" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="au-subject-filter" aria-label="Subject type">{subjects.map(item => <button key={item} type="button" className={subject === item ? 'active' : ''} aria-pressed={subject === item} onClick={() => setSubject(item)}>{item === 'ALL' ? 'All' : consumerCopy.subjects[item]}</button>)}</div></div>
    <div className="au-market-table" role="table" aria-label="Explore subjects">
      <div className="au-market-columns" role="row"><span role="columnheader">Subject</span><span role="columnheader">Source</span><span role="columnheader">Price / activity</span><span role="columnheader">Trend / observed period</span><span role="columnheader" className="au-sr-only">Open</span></div>
      {loading && <div className="au-list-message" role="status">Loading Devnet markets…</div>}
      {visible.length === 0 && !loading ? <EmptyState title={consumerCopy.states.empty} detail={consumerCopy.states.emptyDetail} /> : visible.map(market => <button className="au-market-row" role="row" type="button" key={market.id} onClick={() => onSelectMarket(market.id)} aria-label={`Open ${market.title} subject`}>
        <span className="au-market-identity" role="cell"><MarketArtwork market={market} /><span><strong>{market.title}</strong><small>{market.creatorLabel ? `${market.creatorLabel} · ` : ''}{market.subtitle}</small></span></span>
        <span role="cell" className="au-source-cell"><strong>{market.source.mode === 'REFERENCE' ? 'Public source' : 'Devnet observed'}</strong><small>{market.source.mode === 'REFERENCE' ? new Date(market.source.asOfMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : <MarketStatus phase={market.phase} />}</small></span>
        <span role="cell" className="au-price-cell"><strong>{market.source.mode === 'REFERENCE' ? market.activity ? formatDisplayPrice(market.activity.value, market.activity.unit) : '—' : formatDisplayPrice(market.latestPrice, market.priceUnit)}</strong><small>{market.source.mode === 'REFERENCE' ? market.activity?.label ?? 'Source linked · view only' : market.latestPrice === null ? consumerCopy.states.missingPrice : market.phase === 'CURVE' ? 'Curve quote' : 'Reference price'}</small></span>
        <span role="cell" className="au-trend-cell"><MarketSparkline market={market} history={histories?.[market.id]} /></span>
        <span role="cell" className="au-row-arrow" aria-hidden="true">↗</span>
      </button>)}
    </div>
    <p className="au-data-footnote">Trends show actual observations of the named metric. Percentages compare the first and last displayed values; they are not trading returns. Prices come from Devnet markets. Chips and trading are available on connected markets.</p>
  </section>;
}
