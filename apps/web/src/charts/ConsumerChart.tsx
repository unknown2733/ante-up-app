import { useEffect, useRef, useState } from 'react';
import type { ConsumerAction, ConsumerPeriod, ConsumerSeries, MarketHistory } from '../../../../contracts/consumer';
import { actionName, actionResult, chartBounds, chartClusters, chartPoints, chartSegments, portraitImageSource, scopedChartHistory,
  CHART_BOTTOM, CHART_LEFT, CHART_RIGHT, CHART_TOP } from './chartModel';
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
const colors: Record<ConsumerSeries['kind'], string> = {
  CURVE_PRICE: '#dd681f', REFERENCE_PRICE: '#275eaf', TRADE_PRICE: '#171717', ATTENTION_INDEX: '#5874a2', ACTIVITY_COUNT: '#275eaf',
};
const seriesName: Record<ConsumerSeries['kind'], string> = {
  CURVE_PRICE: 'Curve price', REFERENCE_PRICE: 'Index reference', TRADE_PRICE: 'Trade price', ATTENTION_INDEX: 'Attention index', ACTIVITY_COUNT: 'Public activity',
};
const when = (ms: number) => new Intl.DateTimeFormat('en', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
}).format(ms);
const number = (value: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 4 }).format(value);
const shortName = (value: string) => value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;

function Portrait({ src, label, type }: { src?: string; label: string; type: 'person' | 'subject' }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const imageSrc = portraitImageSource(src, failedSrc);
  return <span className={`au-chart-portrait au-chart-portrait-${type}`} aria-hidden="true">
    <span>{label.trim().slice(0, 1).toUpperCase() || '•'}</span>
    {imageSrc && <img key={imageSrc} src={imageSrc} alt="" loading="lazy" onError={() => setFailedSrc(imageSrc)} onLoad={() => setFailedSrc(null)} />}
  </span>;
}

export function ConsumerChart({ history, onSelectAction, onPeriodChange, actorHref, recordHref, noteHref }: ConsumerChartProps) {
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [markerId, setMarkerId] = useState<string | null>(null);
  const markerTrack = useRef<HTMLDivElement>(null);
  const [markerWidth, setMarkerWidth] = useState(640);
  useEffect(() => {
    const track = markerTrack.current;
    if (!track || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width && Number.isFinite(width)) setMarkerWidth(width);
    });
    observer.observe(track);
    return () => observer.disconnect();
  }, [history.market.id, history.period, history.source.asOfMs, history.actions.length]);
  const sourceLabel = history.source.mode === 'REFERENCE' ? 'Public source data' : history.source.mode === 'DEMO' ? 'Sample history' : 'Live Devnet';
  const scopedHistory = scopedChartHistory(history);
  const series = scopedHistory.series.find(item => item.id === seriesId)
    ?? scopedHistory.series.find(item => item.kind === 'CURVE_PRICE' || item.kind === 'REFERENCE_PRICE')
    ?? scopedHistory.series[0] ?? null;
  const bounds = chartBounds(scopedHistory);
  const points = chartPoints(series, bounds);
  const segments = series ? chartSegments(series, points) : [];
  const clusters = chartClusters(scopedHistory.actions, bounds, Math.max(28, 44 * 640 / markerWidth));
  const selected = clusters.find(cluster => cluster.id === markerId) ?? null;
  const values = points.map(point => point.value);
  const visibleGapCount = series?.gaps.filter(gap => gap.toMs >= bounds.start && gap.fromMs <= bounds.end).length ?? 0;
  const low = values.length ? Math.min(...values) : null;
  const high = values.length ? Math.max(...values) : null;
  const actorLink = actorHref ?? ((id: string) => `/profiles/${encodeURIComponent(id)}`);
  const recordLink = recordHref ?? ((id: string) => `/records/${encodeURIComponent(id)}`);
  const noteLink = noteHref ?? ((action: ConsumerAction) =>
    `${recordLink(action.recordId ?? action.id)}#note-${encodeURIComponent(action.note?.id ?? '')}`);

  return <section className="au-chart" aria-label={`${history.market.title} chart and chip activity`}>
    <div className="au-chart-head">
      <div><span className="au-chart-eyebrow">{sourceLabel}</span><h2>{history.market.title} history</h2></div>
      <div className="au-chart-periods" role="group" aria-label="Chart period">
        {periods.map(period => <button key={period} type="button" aria-pressed={period === history.period}
          disabled={!onPeriodChange} onClick={() => onPeriodChange?.(period)}>{period}</button>)}
      </div>
    </div>
    <div className="au-chart-series" role="group" aria-label="Chart data">
      {scopedHistory.series.map(item => <button key={item.id} type="button" aria-pressed={item.id === series?.id}
        onClick={() => { setSeriesId(item.id); setMarkerId(null); }}>
        <span className="au-chart-swatch" style={{ background: colors[item.kind] }} />{item.kind === 'ACTIVITY_COUNT' ? item.label : seriesName[item.kind]}
      </button>)}
    </div>
    <div className="au-chart-plot">{series && points.length && low !== null && high !== null ? <>
      <div className="au-chart-canvas">
        <svg viewBox="0 0 640 220" role="img" preserveAspectRatio="none"
          aria-label={`${seriesName[series.kind]}, ${points.length} ${history.source.mode === 'DEMO' ? 'sample' : 'observed'} points, ${number(low)} to ${number(high)} ${series.unit}. Missing intervals are not connected.`}>
          <line x1={CHART_LEFT} y1={CHART_BOTTOM} x2={CHART_RIGHT} y2={CHART_BOTTOM} className="au-chart-axis" />
          <line x1={CHART_LEFT} y1={CHART_TOP} x2={CHART_LEFT} y2={CHART_BOTTOM} className="au-chart-axis" />
          {segments.map((segment, index) => segment.length > 1 && <polyline key={index} fill="none"
            stroke={colors[series.kind]} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round"
            points={segment.map(point => `${point.x},${point.y}`).join(' ')} />)}
          {points.map((point, index) => <circle key={`${point.atMs}-${index}`} cx={point.x} cy={point.y}
            r={series.kind === 'TRADE_PRICE' ? 4 : 2.5} fill={colors[series.kind]} />)}
        </svg>
        <span className="au-chart-ylabel au-chart-ylabel-top" aria-hidden="true">{number(high)}</span>
        <span className="au-chart-ylabel au-chart-ylabel-bottom" aria-hidden="true">{number(low)}</span>
      </div>
      <div className="au-chart-caption"><span>{when(bounds.start)}</span><span>{series.unit} · {points.length} points · {visibleGapCount} gaps</span><span>{when(bounds.end)}</span></div>
    </> : <div className="au-chart-empty">No {history.source.mode === 'DEMO' ? 'sample' : 'observed'} {series ? seriesName[series.kind].toLowerCase() : 'chart'} data in this period.</div>}</div>

    {!!clusters.length && <div ref={markerTrack} className="au-chart-markers" aria-label="Chip activity on this chart">
      {clusters.map(cluster => {
        const first = cluster.actions[0];
        const single = cluster.actions.length === 1;
        return <button key={cluster.id} type="button" className={`au-chart-marker ${single && (first.kind === 'BUY' || first.kind === 'SELL') ? 'au-chart-marker-trade' : ''}`}
          style={{ left: `clamp(22px, ${cluster.x / 640 * 100}%, calc(100% - 22px))` }} aria-expanded={selected?.id === cluster.id}
          aria-label={single ? `${actionName[first.kind]} by ${first.actorLabel} on ${history.market.title}, ${when(first.atMs)}. Show details.`
            : `${cluster.actions.length} chip and trade actions near ${when(first.atMs)}. Show details.`}
          onMouseEnter={() => setMarkerId(cluster.id)} onFocus={() => setMarkerId(cluster.id)}
          onClick={() => setMarkerId(cluster.id)}>
          <span aria-hidden="true">{single ? first.kind === 'CALL_OPEN' ? '+' : first.kind === 'CALL_CLOSE' ? '↶' : '•' : cluster.actions.length}</span>
        </button>;
      })}
    </div>}

    {selected && <div className="au-chart-detail" role="region" aria-label="Selected chip activity">
      <div className="au-chart-detail-head"><strong>{selected.actions.length === 1 ? 'Chip activity' : `${selected.actions.length} activities`}</strong>
        <button type="button" onClick={() => setMarkerId(null)} aria-label="Close activity details">×</button></div>
      {selected.actions.map(action => <article className="au-chart-action" key={action.id}>
        <div className="au-chart-action-summary">
          <Portrait src={action.actorAvatarUrl} label={action.actorLabel} type="person" />
          <div><strong>{actionName[action.kind]}</strong><span>{shortName(action.actorLabel)} · {when(action.atMs)}</span></div>
        </div>
        <div className="au-chart-subject"><Portrait src={history.market.thumbnailUrl} label={history.market.title} type="subject" />
          <div><span>On {history.market.title}</span><strong>{actionResult(action)}</strong></div></div>
        {action.value !== null && scopedHistory.series.some(item => item.id === action.seriesId) &&
          <p className="au-chart-at-value">{seriesName[scopedHistory.series.find(item => item.id === action.seriesId)!.kind]} then: {action.value} {scopedHistory.series.find(item => item.id === action.seriesId)!.unit}</p>}
        {action.note && <p className="au-chart-note">{action.note.body}<small>{action.note.timing === 'ADDED_LATER' ? 'Added later' : 'At the time'}{action.note.version > 1 ? ' · Edited' : ''}</small></p>}
        <div className="au-chart-action-links">
          <a href={actorLink(action.actorId)}>View profile <span className="au-chart-wallet">{shortName(action.actorLabel)}</span></a>
          {action.recordId && <a href={recordLink(action.recordId)}>View record</a>}
          {action.note && <a href={noteLink(action)}>View note</a>}
          <button type="button" onClick={() => onSelectAction(action)}>View activity</button>
        </div>
      </article>)}
    </div>}
    <details className="au-chart-source"><summary>About this chart</summary>
      <p>{history.source.label}. Updated {when(history.source.asOfMs)}. {history.source.mode === 'DEMO'
        ? 'Sample values and example activity are illustrative; they are not real wallet results or executable markets.'
        : history.source.mode === 'REFERENCE' ? 'Historical observations from the linked public source. The date range and metric apply to this source.' : 'Observed history comes from Devnet records. Chip activity tracks attention, not cash profit.'}</p>
      {series && <p>{series.kind === 'ACTIVITY_COUNT' ? series.label : seriesName[series.kind]} · {series.unit}. Missing intervals are left blank. {history.source.mode === 'REFERENCE' ? 'This activity is not a token price or a trade return.' : 'Chart values are informational; current quotes and receipts govern transactions.'}</p>}
      {history.source.sourceUrl && <a href={history.source.sourceUrl}>View data source</a>}
    </details>
  </section>;
}
