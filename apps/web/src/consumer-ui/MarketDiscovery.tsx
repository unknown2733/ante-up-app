import { useMemo, useState } from 'react';
import type { ConsumerMarket, ConsumerMode, ConsumerSubject } from '../../../../contracts/consumer';
import { consumerCopy, formatChange, formatDisplayPrice } from './copy';
import { EmptyState, MarketStatus, SubjectGlyph } from './controls';

export interface MarketDiscoveryProps {
  markets: ConsumerMarket[];
  mode: ConsumerMode;
  loading?: boolean;
  error?: string | null;
  onSelectMarket: (marketId: string) => void;
  onRegister?: () => void;
}

const subjects: Array<ConsumerSubject | 'ALL'> = ['ALL', 'KEYWORD', 'VIDEO', 'TRACK', 'ALBUM', 'ACCOUNT'];

export function MarketDiscovery({ markets, mode, loading = false, error, onSelectMarket, onRegister }: MarketDiscoveryProps) {
  const [query, setQuery] = useState('');
  const [subject, setSubject] = useState<ConsumerSubject | 'ALL'>('ALL');
  const visible = useMemo(() => markets.filter((market) => market.source.mode === mode && (subject === 'ALL' || market.subject === subject) && `${market.title} ${market.subtitle}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [markets, mode, subject, query]);
  return <section className="au-discovery" aria-labelledby="au-discovery-title">
    <div className="au-page-heading"><div><p className="au-kicker">DISCOVER / {mode === 'DEMO' ? 'SIMULATED MARKETS' : 'DEVNET MARKETS'}</p><h1 id="au-discovery-title">Markets<span>.</span></h1><p>Follow the movement. Make a call or trade where available.</p></div>{onRegister && mode === 'LIVE' && <button type="button" className="au-text-action" onClick={onRegister}>Register a keyword <span aria-hidden="true">↗</span></button>}</div>
    <div className="au-discovery-tools"><label className="au-search"><span aria-hidden="true">⌕</span><span className="au-sr-only">Search markets</span><input type="search" placeholder="Search markets" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="au-subject-filter" aria-label="Subject type">{subjects.map((item) => <button key={item} type="button" className={subject === item ? 'active' : ''} aria-pressed={subject === item} onClick={() => setSubject(item)}>{item === 'ALL' ? 'All' : consumerCopy.subjects[item]}</button>)}</div></div>
    <div className="au-market-table" role="table" aria-label={`${consumerCopy.modes[mode]} markets`}>
      <div className="au-market-columns" role="row"><span role="columnheader">Market</span><span role="columnheader">Stage</span><span role="columnheader">Price</span><span role="columnheader">Change</span><span role="columnheader" className="au-sr-only">Open</span></div>
      {loading ? <div className="au-list-message" role="status">{consumerCopy.states.loading}</div> : error ? <div className="au-list-message au-list-error" role="alert">{error}</div> : visible.length === 0 ? <EmptyState title={consumerCopy.states.empty} detail={consumerCopy.states.emptyDetail} /> : visible.map((market) => <button className="au-market-row" role="row" type="button" key={market.id} onClick={() => onSelectMarket(market.id)} aria-label={`Open ${market.title} market`}>
        <span className="au-market-identity" role="cell"><SubjectGlyph subject={market.subject} /><span><strong>{market.title}</strong><small>{market.subtitle}</small></span></span>
        <span role="cell"><MarketStatus phase={market.phase} /></span>
        <span role="cell" className="au-price-cell"><strong>{formatDisplayPrice(market.latestPrice, market.priceUnit)}</strong><small>{market.latestPrice === null ? consumerCopy.states.missingPrice : market.phase === 'CURVE' ? 'Curve quote' : 'Reference price'}</small></span>
        <span role="cell" className={`au-change-cell ${market.changeFraction !== null && market.changeFraction < 0 ? 'negative' : ''}`}>{formatChange(market.changeFraction)}</span>
        <span role="cell" className="au-row-arrow" aria-hidden="true">↗</span>
      </button>)}
    </div>
    <p className="au-data-footnote">{mode === 'DEMO' ? 'Illustrative history and actors. Demo activity is separate from Devnet balances and rankings.' : 'Prices are display values. Review a fresh quote and wallet transaction before trading.'}</p>
  </section>;
}
