import type { ConsumerAction, ConsumerPeriod, ConsumerSeries, MarketHistory } from '../../../../contracts/consumer';

export const CHART_LEFT = 48;
export const CHART_RIGHT = 620;
export const CHART_TOP = 24;
export const CHART_BOTTOM = 190;

const durations: Record<Exclude<ConsumerPeriod, 'ALL'>, number> = {
  '1D': 86_400_000, '1W': 7 * 86_400_000, '1M': 30 * 86_400_000,
};

export interface ChartBounds { start: number; end: number }
export interface ChartPoint { atMs: number; value: number; x: number; y: number }
export interface ChartCluster { id: string; x: number; actions: ConsumerAction[] }

/** A single catalog may show both sources; a chart must keep its own evidence lane. */
export function scopedChartHistory(history: MarketHistory): MarketHistory {
  return { ...history,
    series: history.series.filter(series => series.source.mode === history.source.mode),
    actions: history.actions.filter(action => action.source.mode === history.source.mode && action.marketId === history.market.id),
  };
}

export function chartBounds(history: MarketHistory): ChartBounds {
  const end = history.source.asOfMs;
  const observed = [...history.series.flatMap(series => series.points.map(point => point.atMs)),
    ...history.actions.map(action => action.atMs)].filter(Number.isFinite);
  const start = history.period === 'ALL' ? Math.min(end - 60_000, ...observed) : end - durations[history.period];
  return { start, end: Math.max(start + 1, end) };
}

export function chartX(atMs: number, bounds: ChartBounds): number {
  return CHART_LEFT + (atMs - bounds.start) / (bounds.end - bounds.start) * (CHART_RIGHT - CHART_LEFT);
}

/** Chart coordinates are display math only; financial calculations stay in receipts. */
export function chartPoints(series: ConsumerSeries | null, bounds: ChartBounds): ChartPoint[] {
  if (!series) return [];
  const numeric = series.points
    .map(point => ({ atMs: point.atMs, value: Number(point.value) }))
    .filter(point => Number.isFinite(point.value) && Number.isFinite(point.atMs) &&
      point.atMs >= bounds.start && point.atMs <= bounds.end)
    .sort((a, b) => a.atMs - b.atMs);
  if (!numeric.length) return [];
  const values = numeric.map(point => point.value);
  let low = Math.min(...values), high = Math.max(...values);
  if (low === high) { const padding = Math.max(Math.abs(low) * 0.05, 0.01); low -= padding; high += padding; }
  return numeric.map(point => ({ ...point, x: chartX(point.atMs, bounds),
    y: CHART_BOTTOM - (point.value - low) / (high - low) * (CHART_BOTTOM - CHART_TOP) }));
}

/** Gap endpoints may be observed points. Only a line crossing the interval is forbidden. */
export function chartSegments(series: ConsumerSeries, points: ChartPoint[]): ChartPoint[][] {
  if (series.kind === 'TRADE_PRICE') return [];
  const segments: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  for (const point of points) {
    const previous = current.at(-1);
    if (previous && series.gaps.some(gap => previous.atMs <= gap.fromMs && point.atMs >= gap.toMs)) {
      segments.push(current); current = [];
    }
    current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}

export function chartClusters(actions: ConsumerAction[], bounds: ChartBounds, distance = 28): ChartCluster[] {
  const clusters: ChartCluster[] = [];
  const ordered = actions.filter(action => Number.isFinite(action.atMs) && action.atMs >= bounds.start && action.atMs <= bounds.end)
    .sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
  for (const action of ordered) {
    const x = chartX(action.atMs, bounds);
    const prior = clusters.at(-1);
    if (prior && x - prior.x < distance) prior.actions.push(action);
    else clusters.push({ id: action.id, x, actions: [action] });
  }
  return clusters;
}

export const actionName: Record<ConsumerAction['kind'], string> = {
  CALL_OPEN: 'Placed a chip', CALL_CLOSE: 'Took back a chip', BUY: 'Bought', SELL: 'Sold',
};

/** A failed image URL must not suppress a later, different URL. */
export function portraitImageSource(src: string | undefined, failedSrc: string | null): string | null {
  return src && src !== failedSrc ? src : null;
}

export function actionResult(action: ConsumerAction): string {
  if (action.kind === 'CALL_OPEN') return 'Chip placed';
  if (action.kind === 'CALL_CLOSE') {
    if (action.returnFraction === null || !Number.isFinite(action.returnFraction)) return 'Attention change unavailable';
    const amount = new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(action.returnFraction * 100);
    return `Attention change ${action.returnFraction >= 0 ? '+' : ''}${amount}%`;
  }
  return action.source.mode === 'DEMO' ? 'Example trade' : 'Trade';
}
