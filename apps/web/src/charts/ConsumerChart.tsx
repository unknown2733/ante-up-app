import { useState } from 'react';
import type { ConsumerAction, ConsumerPeriod, ConsumerSeries, MarketHistory } from '../../../../contracts/consumer';
import './ConsumerChart.css';

export interface ConsumerChartProps {
  history: MarketHistory;
  onSelectAction: (action: ConsumerAction) => void;
  onPeriodChange?: (period: ConsumerPeriod) => void;
  actorHref?: (actorId: string) => string;
  recordHref?: (recordId: string) => string;
  noteHref?: (action: ConsumerAction) => string;
}
const periods: ConsumerPeriod[] = ['1D', '1W', '1M', 'ALL'];
const colors: Record<ConsumerSeries['kind'], string> = { CURVE_PRICE: '#dd681f', REFERENCE_PRICE: '#275eaf', TRADE_PRICE: '#171717', ATTENTION_INDEX: '#5874a2' };
const names: Record<ConsumerAction['kind'], string> = { CALL_OPEN: 'Made a call', CALL_CLOSE: 'Closed a call', BUY: 'Bought', SELL: 'Sold' };
const when = (ms: number) => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }).format(ms);
const number = (value: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 4 }).format(value);

export function ConsumerChart({ history, onSelectAction, onPeriodChange, actorHref, recordHref, noteHref }: ConsumerChartProps) {
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [markerId, setMarkerId] = useState<string | null>(null);
  const series = history.series.find(item => item.id === seriesId)
    ?? history.series.find(item => item.kind === 'CURVE_PRICE' || item.kind === 'REFERENCE_PRICE') ?? history.series[0] ?? null;
  const end = history.source.asOfMs;
  const duration = history.period === '1D' ? 86_400_000 : history.period === '1W' ? 604_800_000 : history.period === '1M' ? 2_592_000_000 : null;
  const times = [...history.series.flatMap(item => item.points.map(point => point.atMs)), ...history.actions.map(action => action.atMs)];
  const start = duration === null ? Math.min(end - 60_000, ...times) : end - duration;
  const span = Math.max(1, end - start);
  const x = (atMs: number) => 48 + (atMs - start) / span * 572;
  const numeric = (series?.points ?? []).map(point => ({ ...point, numeric: Number(point.value) })).filter(point => Number.isFinite(point.numeric));
  const values = numeric.map(point => point.numeric);
  let low = Math.min(...values), high = Math.max(...values);
  if (low === high) { const pad = Math.max(Math.abs(low) * 0.05, 0.01); low -= pad; high += pad; }
  const y = (value: number) => 190 - (value - low) / (high - low) * 166;
  const segments: typeof numeric[] = [];
  if (series?.kind !== 'TRADE_PRICE') {
    let segment: typeof numeric = [];
    for (const point of numeric) {
      const prior = segment.at(-1);
      if (prior && series?.gaps.some(gap => prior.atMs <= gap.fromMs && point.atMs >= gap.toMs)) { segments.push(segment); segment = []; }
      segment.push(point);
    }
    if (segment.length) segments.push(segment);
  }
  const clusters: Array<{ id: string; x: number; actions: ConsumerAction[] }> = [];
  for (const action of [...history.actions].filter(item => item.atMs >= start && item.atMs <= end).sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id))) {
    const px = x(action.atMs), prior = clusters.at(-1);
    if (prior && px - prior.x < 28) prior.actions.push(action);
    else clusters.push({ id: action.id, x: px, actions: [action] });
  }
  const selected = clusters.find(cluster => cluster.id === markerId) ?? null;
  const actorLink = actorHref ?? ((id: string) => `/profiles/${encodeURIComponent(id)}`);
  const recordLink = recordHref ?? ((id: string) => `/records/${encodeURIComponent(id)}`);
  const noteLink = noteHref ?? ((action: ConsumerAction) => `${recordLink(action.recordId ?? action.id)}#note-${encodeURIComponent(action.note?.id ?? '')}`);
  return <section className="au-chart" aria-label={`${history.market.title} history`}>
    <div className="au-chart-head"><div><span className="au-chart-eyebrow">{history.source.label}</span><h2>{history.market.title} history</h2></div>
      <div className="au-chart-periods" role="group" aria-label="Chart period">{periods.map(period => <button key={period} type="button" aria-pressed={period === history.period} disabled={!onPeriodChange} onClick={() => onPeriodChange?.(period)}>{period}</button>)}</div></div>
    <div className="au-chart-series" role="group" aria-label="Chart series">{history.series.map(item => <button key={item.id} type="button" aria-pressed={item.id === series?.id} onClick={() => { setSeriesId(item.id); setMarkerId(null); }}><span className="au-chart-swatch" style={{ background: colors[item.kind] }} />{item.label}</button>)}</div>
    <div className="au-chart-plot">{series && numeric.length ? <>
      <div className="au-chart-canvas"><svg viewBox="0 0 640 220" role="img" aria-label={`${series.label}, ${numeric.length} ${history.source.mode === 'DEMO' ? 'demo' : 'finalized'} points, range ${number(low)} to ${number(high)} ${series.unit}; gaps are not connected`} preserveAspectRatio="none">
        <line x1="48" y1="190" x2="620" y2="190" className="au-chart-axis" /><line x1="48" y1="24" x2="48" y2="190" className="au-chart-axis" />
        {segments.map((segment, index) => segment.length > 1 && <polyline key={index} fill="none" stroke={colors[series.kind]} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" points={segment.map(point => `${x(point.atMs)},${y(point.numeric)}`).join(' ')} />)}
        {numeric.map((point, index) => <circle key={`${point.atMs}-${index}`} cx={x(point.atMs)} cy={y(point.numeric)} r={series.kind === 'TRADE_PRICE' ? 4 : 2.5} fill={colors[series.kind]} />)}
      </svg><span className="au-chart-ylabel au-chart-ylabel-top" aria-hidden="true">{number(high)}</span><span className="au-chart-ylabel au-chart-ylabel-bottom" aria-hidden="true">{number(low)}</span></div>
      <div className="au-chart-caption"><span>{when(start)}</span><span>{series.unit} · {numeric.length} {history.source.mode === 'DEMO' ? 'demo' : 'finalized'} points · {series.gaps.length} gaps</span><span>{when(end)}</span></div>
    </> : <div className="au-chart-empty">No {history.source.mode === 'DEMO' ? 'demo' : 'finalized'} {series?.label.toLowerCase() ?? 'price'} history for this period.</div>}</div>
    {!!clusters.length && <div className="au-chart-markers" aria-label="Participation markers">{clusters.map(cluster => <button key={cluster.id} type="button" className="au-chart-marker" style={{ left: `${cluster.x / 640 * 100}%` }} aria-label={`${cluster.actions.length} ${cluster.actions.length === 1 ? 'action' : 'actions'} at ${when(cluster.actions[0].atMs)}`} aria-expanded={selected?.id === cluster.id} onMouseEnter={() => setMarkerId(cluster.id)} onFocus={() => setMarkerId(cluster.id)} onClick={() => setMarkerId(cluster.id)}>{cluster.actions.length > 1 ? cluster.actions.length : cluster.actions[0].kind === 'CALL_OPEN' ? '+' : cluster.actions[0].kind === 'CALL_CLOSE' ? '−' : '•'}</button>)}</div>}
    {selected && <div className="au-chart-detail" role="region" aria-label="Selected participation"><div className="au-chart-detail-head"><strong>{selected.actions.length} {selected.actions.length === 1 ? 'action' : 'actions'}</strong><button type="button" onClick={() => setMarkerId(null)} aria-label="Close marker details">×</button></div>
      {selected.actions.map(action => <div className="au-chart-action" key={action.id}><button type="button" onClick={() => onSelectAction(action)}><strong>{names[action.kind]}</strong><span>{when(action.atMs)}</span></button><div className="au-chart-action-links"><a href={actorLink(action.actorId)}>{action.actorLabel}</a>{action.recordId && <a href={recordLink(action.recordId)}>Record</a>}{action.note && <a href={noteLink(action)}>Note</a>}</div><p>{action.kind.startsWith('CALL') ? 'Free call · no trade fill' : 'Finalized trade'}{action.value && action.seriesId === series?.id ? ` · ${action.value} ${series.unit}` : ''}{action.returnFraction !== null ? ` · ${action.returnFraction >= 0 ? '+' : ''}${number(action.returnFraction * 100)}%` : ''}</p>{action.note && <p className="au-chart-note">{action.note.body}{action.note.timing === 'ADDED_LATER' ? ' · Added later' : ''}{action.note.version > 1 ? ' · Edited' : ''}</p>}</div>)}
    </div>}
  </section>;
}
