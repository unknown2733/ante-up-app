import { useEffect, useRef, useState, useId } from 'react';
import type { PointerEvent, KeyboardEvent } from 'react';
import type { ConsumerAction, ConsumerPeriod, ConsumerSeries, MarketHistory } from '../../../../contracts/consumer';
import { actionName, actionResult, chartBounds, chartClusters, chartPoints, chartSegments, portraitImageSource, scopedChartHistory,
  CHART_BOTTOM, CHART_LEFT, CHART_RIGHT, CHART_TOP, inspectChart, chartViewport, chartX } from './chartModel';
import type { MarketView } from '../../../../contracts/types';
import { AttentionContext } from '../consumer-ui/AttentionContext';
import type { ChartBounds } from './chartModel';
import './ConsumerChart.css';
import { marketDisplayTitle } from '../consumer-ui/catalog';

export interface ConsumerChartProps {
  history: MarketHistory;
  marketContext?: MarketView | null;
  preferredSeriesKind?: ConsumerSeries['kind'];
  onSelectAction: (action: ConsumerAction) => void;
  onPeriodChange?: (period: ConsumerPeriod) => void;
  actorHref?: (actorId: string) => string;
  recordHref?: (recordId: string) => string;
  noteHref?: (action: ConsumerAction) => string;
}

const periods: ConsumerPeriod[] = ['1D', '1W', '1M', 'ALL'];
const colors: Record<ConsumerSeries['kind'], string> = {
  CURVE_PRICE: '#bc4b2c', REFERENCE_PRICE: '#8b3f2a', TRADE_PRICE: '#241c18', ATTENTION_INDEX: '#8b7464', ACTIVITY_COUNT: '#a36344',
};
const seriesName: Record<ConsumerSeries['kind'], string> = {
  CURVE_PRICE: 'Curve price', REFERENCE_PRICE: 'Index reference', TRADE_PRICE: 'Trade price', ATTENTION_INDEX: 'Attention index', ACTIVITY_COUNT: 'Public activity',
};
const when = (ms: number) => new Intl.DateTimeFormat('en', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
}).format(ms);
const number = (value: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 4 }).format(value);
const observedWhen = (ms: number) => new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, timeZone: 'UTC', timeZoneName: 'short',
}).format(ms);
const shortName = (value: string) => value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
const reportWhen = (ms: number) => new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(ms);

function Portrait({ src, label, type }: { src?: string; label: string; type: 'person' | 'subject' }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const imageSrc = portraitImageSource(src, failedSrc);
  return <span className={`au-chart-portrait au-chart-portrait-${type}`} aria-hidden="true">
    <span>{label.trim().slice(0, 1).toUpperCase() || '•'}</span>
    {imageSrc && <img key={imageSrc} src={imageSrc} alt="" loading="lazy" onError={() => setFailedSrc(imageSrc)} onLoad={() => setFailedSrc(null)} />}
  </span>;
}

export function ConsumerChart({ history, marketContext, preferredSeriesKind, onSelectAction, onPeriodChange, actorHref, recordHref, noteHref }: ConsumerChartProps) {
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [markerId, setMarkerId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ChartBounds | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const instructionId = useId();
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
  const sourceLabel = history.source.mode === 'REFERENCE' ? 'Public source data' : history.source.mode === 'DEMO' ? 'Sample history' : 'Market history';
  useEffect(() => { setSeriesId(null); }, [preferredSeriesKind]);
  const scopedHistory = scopedChartHistory(history);
  const series = scopedHistory.series.find(item => item.id === seriesId)
    ?? scopedHistory.series.find(item => item.kind === preferredSeriesKind && item.points.length > 0)
    ?? scopedHistory.series.find(item => item.points.length > 0 && (item.kind === 'CURVE_PRICE' || item.kind === 'REFERENCE_PRICE'))
    ?? scopedHistory.series.find(item => item.points.length > 1 && item.evidence !== 'ILLUSTRATIVE')
    ?? scopedHistory.series.find(item => item.evidence === 'ILLUSTRATIVE')
    ?? scopedHistory.series.find(item => item.points.length > 0)
    ?? scopedHistory.series[0] ?? null;
  const illustrative = series?.evidence === 'ILLUSTRATIVE';
  const fullBounds = chartBounds({ ...scopedHistory, series: series ? [series] : [] });
  const bounds = viewport ? chartViewport(fullBounds, (viewport.start + viewport.end) / 2, viewport.end - viewport.start) : fullBounds;
  useEffect(() => { setViewport(null); setCursor(null); setMarkerId(null); }, [history.market.id, history.period, series?.id]);
  const points = chartPoints(series, bounds);
  const dateOnly = series?.timeBasis === 'REPORT_DATE';
  const axisWhen = dateOnly ? reportWhen : when;
  const snapshot = history.source.mode === 'REFERENCE' && !dateOnly && series?.kind === 'ACTIVITY_COUNT' && series.points.length === 1
    ? series.points[0] : null;
  const snapshotOnly = !!snapshot && history.period === 'ALL' && scopedHistory.series.every(item => item.kind === 'ACTIVITY_COUNT' && item.points.length <= 1);
  const sourceUrl = illustrative ? undefined : series?.source.sourceUrl ?? history.source.sourceUrl;
  const segments = series ? chartSegments(series, points) : [];
  const clusters = chartClusters(scopedHistory.actions, bounds, Math.max(28, 44 * 640 / markerWidth));
  const selected = clusters.find(cluster => cluster.id === markerId) ?? null;
  const values = points.map(point => point.value);
  const visibleGapCount = series?.gaps.filter(gap => gap.toMs >= bounds.start && gap.fromMs <= bounds.end).length ?? 0;
  const low = values.length ? Math.min(...values) : null;
  const high = values.length ? Math.max(...values) : null;
  const first = points[0], latest = points.at(-1);
  const inspected = cursor === null ? null : inspectChart(points, series?.gaps ?? [], cursor);
  const zoomed = bounds.end - bounds.start < fullBounds.end - fullBounds.start;
  const minSpan = Math.max(1, (fullBounds.end - fullBounds.start) / 32);
  const cursorX = cursor === null ? null : chartX(inspected?.atMs ?? cursor, bounds);
  const inspectPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== 'mouse' && event.buttons === 0 && event.type !== 'pointerdown') return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * 640;
    if (x < CHART_LEFT || x > CHART_RIGHT) { setCursor(null); return; }
    setCursor(bounds.start + (x - CHART_LEFT) / (CHART_RIGHT - CHART_LEFT) * (bounds.end - bounds.start));
  };
  const inspectKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') { setCursor(null); return; }
    const current = inspected ? points.findIndex(point => point.atMs === inspected.atMs) : points.length - 1;
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.max(0, Math.min(points.length - 1, current + (event.key === 'ArrowLeft' ? -1 : 1)));
    setCursor(points[index]?.atMs ?? null);
  };
  const zoom = (factor: number) => {
    setViewport(chartViewport(fullBounds, inspected?.atMs ?? (bounds.start + bounds.end) / 2,
      Math.max(minSpan, (bounds.end - bounds.start) * factor)));
    setCursor(null);
  };
  const pan = (direction: number) => {
    const span = bounds.end - bounds.start;
    setViewport(chartViewport(fullBounds, (bounds.start + bounds.end) / 2 + direction * span / 2, span));
    setCursor(null);
  };
  const change = first && latest && points.length > 1 && first.value > 0 ? (latest.value / first.value - 1) * 100 : null;
  const actorLink = actorHref ?? ((id: string) => `/profiles/${encodeURIComponent(id)}`);
  const recordLink = recordHref ?? ((id: string) => `/records/${encodeURIComponent(id)}`);
  const noteLink = noteHref ?? ((action: ConsumerAction) =>
    `${recordLink(action.recordId ?? action.id)}#note-${encodeURIComponent(action.note?.id ?? '')}`);

  return <section className="au-chart" aria-label={`${marketDisplayTitle(history.market.title)} ${snapshot ? 'activity snapshot' : 'chart and chip activity'}`}>
    <div className="au-chart-head">
      <div><span className="au-chart-eyebrow">{illustrative ? 'Chart' : sourceLabel}</span><h2>{marketDisplayTitle(history.market.title)} {illustrative ? 'preview' : snapshot ? 'snapshot' : 'history'}</h2></div>
      {!snapshotOnly && <div className="au-chart-periods" role="group" aria-label="Chart period">
        {periods.map(period => <button key={period} type="button" aria-pressed={period === history.period}
          disabled={!onPeriodChange} onClick={() => onPeriodChange?.(period)}>{period}</button>)}
      </div>}
    </div>
    {(!snapshot || scopedHistory.series.length > 1) && <div className="au-chart-series" role="group" aria-label="Chart data">
      {scopedHistory.series.map(item => <button key={item.id} type="button" aria-pressed={item.id === series?.id}
        title={item.label}
        onClick={() => { setSeriesId(item.id); setMarkerId(null); }}>
        <span className="au-chart-swatch" style={{ background: colors[item.kind] }} />{item.evidence === 'ILLUSTRATIVE' ? 'Illustrative trend' : scopedHistory.series.some(candidate => candidate.evidence === 'ILLUSTRATIVE') ? 'Measured data' : item.kind === 'ACTIVITY_COUNT' ? item.label : seriesName[item.kind]}
      </button>)}
    </div>}
    {preferredSeriesKind && series?.kind !== preferredSeriesKind && !seriesId && history.source.mode === 'LIVE' && <p className="au-chart-hint">{seriesName[preferredSeriesKind]} history is not available. Showing {series ? seriesName[series.kind].toLowerCase() : 'available observations'}.</p>}
    {!snapshot && latest && series && <div className="au-chart-value-summary">
      <div><strong>{number(latest.value)}</strong><span>{series.unit}</span></div>
      <span className={change !== null && change < 0 ? 'negative' : change !== null && change > 0 ? 'positive' : ''}>{change === null ? 'One observation' : `${change > 0 ? '+' : ''}${change.toFixed(2)}%`}<small>{change === null ? 'More observations needed for a trend' : `${illustrative ? 'Preview change' : dateOnly ? 'Activity change' : 'Series change'} · first to last shown`}</small></span>
    </div>}
    {snapshot && series ? <div className="au-chart-snapshot">
      <p className="au-snapshot-label">{series.label}</p>
      <div className="au-snapshot-value"><strong>{number(Number(snapshot.value))}</strong><span>{series.unit}</span></div>
      <p className="au-snapshot-date">Captured <time dateTime={new Date(snapshot.atMs).toISOString()}>{observedWhen(snapshot.atMs)}</time></p>
      {(series.source.observationLabel ?? history.source.observationLabel) && <p className="au-snapshot-observation">{series.source.observationLabel ?? history.source.observationLabel}</p>}
      <p className="au-snapshot-status">Captured snapshot</p>
      <p className="au-snapshot-history-status">Trend unavailable · only one verified observation. A chart will appear when more dated observations are connected.</p>
      {sourceUrl && <a href={sourceUrl}>View source <span aria-hidden="true">↗</span></a>}
    </div> : <div className="au-chart-plot">{series && points.length && low !== null && high !== null ? <>
      <div className="au-chart-canvas">
        <svg viewBox="0 0 640 220" role="img" preserveAspectRatio="none" tabIndex={0}
          className="au-chart-interactive" aria-describedby={instructionId}
          onPointerMove={inspectPointer} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); inspectPointer(event); }}
          onPointerLeave={event => { if (event.pointerType === 'mouse' && !event.buttons) setCursor(null); }}
          onPointerCancel={() => setCursor(null)} onKeyDown={inspectKey}
          aria-label={`${illustrative ? 'Illustrative trend' : seriesName[series.kind]}, ${points.length} ${illustrative || history.source.mode === 'DEMO' ? 'illustrative' : 'observed'} points, ${number(low)} to ${number(high)} ${series.unit}. Missing intervals are not connected.`}>
          {[CHART_TOP, (CHART_TOP + CHART_BOTTOM) / 2].map(y => <line key={y} x1={CHART_LEFT} y1={y} x2={CHART_RIGHT} y2={y} className="au-chart-grid" />)}
          <line x1={CHART_LEFT} y1={CHART_BOTTOM} x2={CHART_RIGHT} y2={CHART_BOTTOM} className="au-chart-axis" />
          <line x1={CHART_LEFT} y1={CHART_TOP} x2={CHART_LEFT} y2={CHART_BOTTOM} className="au-chart-axis" />
          {segments.map((segment, index) => segment.length > 1 && <polyline key={index} fill="none"
            stroke={colors[series.kind]} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"
            points={segment.map(point => `${point.x},${point.y}`).join(' ')} />)}
          {points.map((point, index) => <circle key={`${point.atMs}-${index}`} cx={point.x} cy={point.y}
            r={series.kind === 'TRADE_PRICE' || points.length < 5 ? 4 : 1.5} fill={colors[series.kind]} />)}
          {cursorX !== null && <g className="au-chart-crosshair" pointerEvents="none">
            <line x1={cursorX} x2={cursorX} y1={CHART_TOP} y2={CHART_BOTTOM} />
            {inspected && <><line x1={CHART_LEFT} x2={CHART_RIGHT} y1={inspected.y} y2={inspected.y} />
              <circle cx={inspected.x} cy={inspected.y} r="5" fill={colors[series.kind]} /></>}
          </g>}
        </svg>
        {cursor !== null && <div className="au-chart-tooltip" role="status" style={{ left: `${Math.max(28, Math.min(72, (cursorX ?? CHART_LEFT) / 640 * 100))}%` }}>
          <span>{axisWhen(inspected?.atMs ?? cursor)}</span>
          <strong>{inspected ? `${number(inspected.value)} ${series.unit}` : 'No observation in this gap'}</strong>
          <small>{inspected ? illustrative ? 'Illustrative value' : 'Nearest recorded observation' : 'No interpolated value'}</small>
        </div>}
        <span className="au-chart-ylabel au-chart-ylabel-top" aria-hidden="true">{number(high)}</span>
        <span className="au-chart-ylabel au-chart-ylabel-bottom" aria-hidden="true">{number(low)}</span>
      </div>
      <div className="au-chart-caption"><span>{axisWhen(bounds.start)}</span><span>{series.unit} · {points.length} points · {visibleGapCount} gaps</span><span>{axisWhen(bounds.end)}</span></div>
    </> : <div className="au-chart-empty">No {history.source.mode === 'DEMO' ? 'sample' : 'observed'} {series ? seriesName[series.kind].toLowerCase() : 'chart'} data in this period.</div>}
      <div className="au-chart-navigation" role="group" aria-label="Chart navigation">
        <button type="button" aria-label="Earlier observations" disabled={!zoomed || bounds.start <= fullBounds.start} onClick={() => pan(-1)}>←</button>
        <button type="button" aria-label="Zoom in" disabled={!series || bounds.end - bounds.start <= minSpan} onClick={() => zoom(.5)}>+</button>
        <button type="button" aria-label="Zoom out" disabled={!zoomed} onClick={() => zoom(2)}>−</button>
        <button type="button" disabled={!zoomed && cursor === null} onClick={() => { setViewport(null); setCursor(null); }}>Reset view</button>
        <button type="button" aria-label="Later observations" disabled={!zoomed || bounds.end >= fullBounds.end} onClick={() => pan(1)}>→</button>
      </div>
      <p className="au-chart-hint" id={instructionId}>Hover or drag to inspect · Zoom to explore. Keyboard: ← →, Home, End; Esc to clear.</p>
    </div>}

    {series?.kind === 'ATTENTION_INDEX' && history.source.mode === 'LIVE' && !illustrative && <AttentionContext market={marketContext} observedAtMs={latest?.atMs ?? null} />}
    {dateOnly && <div className="au-chart-history-context"><strong>{series?.aggregation === 'daily' ? 'Daily activity' : 'Cumulative activity'}</strong><span>{series?.observationNote}</span><small>Report dates · ranges end at the latest available report · no live feed</small></div>}

    {dateOnly && series && <details className="au-chart-observations"><summary>View all {series.points.length} recorded observations</summary><div className="au-chart-observation-scroll"><table><thead><tr><th>Report date</th><th>{series.unit}</th><th>Source</th></tr></thead><tbody>{series.points.map(point => <tr key={point.atMs}><td><time dateTime={point.reportedDate}>{point.reportedDate}</time></td><td>{number(Number(point.value))}</td><td>{point.sourceUrl && <a href={point.sourceUrl} target="_blank" rel="noopener noreferrer">View source ↗</a>}</td></tr>)}</tbody></table></div></details>}
    {!snapshot && !!clusters.length && <div ref={markerTrack} className="au-chart-markers" aria-label="Chip activity on this chart">
      {clusters.map(cluster => {
        const first = cluster.actions[0];
        const single = cluster.actions.length === 1;
        return <button key={cluster.id} type="button" className={`au-chart-marker ${single && (first.kind === 'BUY' || first.kind === 'SELL') ? 'au-chart-marker-trade' : ''}`}
          style={{ left: `clamp(22px, ${cluster.x / 640 * 100}%, calc(100% - 22px))` }} aria-expanded={selected?.id === cluster.id}
          aria-label={single ? `${actionName[first.kind]} by ${first.actorLabel} on ${marketDisplayTitle(history.market.title)}, ${when(first.atMs)}. Show details.`
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
        <div className="au-chart-subject"><Portrait src={history.market.thumbnailUrl} label={marketDisplayTitle(history.market.title)} type="subject" />
          <div><span>On {marketDisplayTitle(history.market.title)}</span><strong>{actionResult(action)}</strong></div></div>
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
    <details className="au-chart-source"><summary>About this {snapshot ? 'snapshot' : 'chart'}</summary>
      {illustrative ? <p className="au-chart-illustrative">Illustrative trend uses temporary values, not measured activity. The latest preview index is normalized to 100. The shape and change are illustrative, not historical measurements, investment returns or settlement inputs. Select Measured data to see verified observations.</p> : <><p>{history.source.label}. {dateOnly ? `Latest report ${reportWhen(history.source.asOfMs)} (time zone not supplied)` : `Updated ${when(history.source.asOfMs)}`}. {history.source.mode === 'DEMO'
        ? 'Sample values and example activity are illustrative; they are not real wallet results or executable markets.'
        : history.source.mode === 'REFERENCE' ? snapshot ? 'A captured count from the linked source. A provider report date describes the measurement; the capture time records when the source was retrieved.' : 'Historical observations from the linked public source. The date range and metric apply to this source.' : `Network: Devnet. ${history.source.observationLabel ?? 'Finalized market records.'}`}</p>
      {series && <p>{series.kind === 'ACTIVITY_COUNT' ? series.label : seriesName[series.kind]} · {series.unit}. {snapshot ? 'This snapshot does not establish a trend or a continuously updated feed.' : 'Missing intervals are left blank.'} {history.source.mode === 'REFERENCE' ? 'This activity is not a token price or a trade return.' : 'Chart values are informational; current quotes and receipts govern transactions.'}</p>}
      {history.source.sourceUrl && <a href={history.source.sourceUrl}>View data source</a>}</>}
    </details>
  </section>;
}
