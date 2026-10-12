import { useMemo, useState } from 'react';
import type { ConsumerMarket, ConsumerSubject } from '../../../../contracts/consumer';
import { consumerCopy, formatChange, formatDisplayPrice } from './copy';
import { EmptyState, MarketStatus, SubjectGlyph } from './controls';

export interface MarketDiscoveryProps {
  markets: ConsumerMarket[];
  loading?: boolean;
  liveError?: string | null;
  onSelectMarket: (marketId: string) => void;
  onRegister?: () => void;
}

const subjects: Array<ConsumerSubject | 'ALL'> = ['ALL', 'KEYWORD', 'VIDEO', 'TRACK', 'ALBUM', 'ACCOUNT'];

function MarketArtwork({ market }: { market: ConsumerMarket }) {
  const [failed, setFailed] = useState(false);
  return market.thumbnailUrl && !failed
    ? <img className="au-market-art" src={market.thumbnailUrl} alt={market.imageAlt ?? `${market.title} artwork`} loading="lazy" onError={() => setFailed(true)} />
    : <SubjectGlyph subject={market.subject} />;
}

export function MarketDiscovery({ markets, loading = false, liveError, onSelectMarket, onRegister }: MarketDiscoveryProps) {
  const [query, setQuery] = useState('');
  const [subject, setSubject] = useState<ConsumerSubject | 'ALL'>('ALL');
  const visible = useMemo(() => markets.filter(market =>
    (subject === 'ALL' || market.subject === subject) &&
    `${market.title} ${market.subtitle} ${market.creatorLabel ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [markets, subject, query]);
  return <section className="au-discovery" aria-labelledby="au-discovery-title">
    <div className="au-page-heading"><div><p className="au-kicker">EXPLORE / WHAT'S MOVING</p><h1 id="au-discovery-title">Explore<span>.</span></h1><p>Find a subject, place a chip where available, and follow its movement.</p></div>{onRegister && <button type="button" className="au-text-action" onClick={onRegister}>Register a keyword <span aria-hidden="true">↗</span></button>}</div>
    {liveError && <div className="au-live-warning" role="alert"><strong>Devnet markets could not be loaded.</strong><span>{liveError} Sample histories remain available below; their values are illustrative and cannot be traded.</span></div>}
    <div className="au-discovery-tools"><label className="au-search"><span aria-hidden="true">⌕</span><span className="au-sr-only">Search subjects</span><input type="search" placeholder="Search subjects" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="au-subject-filter" aria-label="Subject type">{subjects.map(item => <button key={item} type="button" className={subject === item ? 'active' : ''} aria-pressed={subject === item} onClick={() => setSubject(item)}>{item === 'ALL' ? 'All' : consumerCopy.subjects[item]}</button>)}</div></div>
    <div className="au-market-table" role="table" aria-label="Explore subjects">
      <div className="au-market-columns" role="row"><span role="columnheader">Subject</span><span role="columnheader">Source</span><span role="columnheader">Price</span><span role="columnheader">Change</span><span role="columnheader" className="au-sr-only">Open</span></div>
      {loading && <div className="au-list-message" role="status">Loading Devnet markets…</div>}
      {visible.length === 0 && !loading ? <EmptyState title={consumerCopy.states.empty} detail={consumerCopy.states.emptyDetail} /> : visible.map(market => <button className="au-market-row" role="row" type="button" key={market.id} onClick={() => onSelectMarket(market.id)} aria-label={`Open ${market.title} subject`}>
        <span className="au-market-identity" role="cell"><MarketArtwork market={market} /><span><strong>{market.title}</strong><small>{market.creatorLabel ? `${market.creatorLabel} · ` : ''}{market.subtitle}</small></span></span>
        <span role="cell" className="au-source-cell"><strong>{market.source.mode === 'DEMO' ? 'Sample history' : 'Devnet observed'}</strong><small>{market.source.mode === 'DEMO' ? 'Illustrative values' : <MarketStatus phase={market.phase} />}</small></span>
        <span role="cell" className="au-price-cell"><strong>{formatDisplayPrice(market.latestPrice, market.priceUnit)}</strong><small>{market.latestPrice === null ? consumerCopy.states.missingPrice : market.source.mode === 'DEMO' ? 'Sample value' : market.phase === 'CURVE' ? 'Curve quote' : 'Reference price'}</small></span>
        <span role="cell" className={`au-change-cell ${market.changeFraction !== null && market.changeFraction < 0 ? 'negative' : ''}`}>{formatChange(market.changeFraction)}</span>
        <span role="cell" className="au-row-arrow" aria-hidden="true">↗</span>
      </button>)}
    </div>
    <p className="au-data-footnote">Sample histories are illustrative. Only supported Devnet markets can accept chips or trades. Review each action before signing.</p>
  </section>;
}
