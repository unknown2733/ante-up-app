import type {
  ConsumerAction, ConsumerLeaderboard, ConsumerMarket, ConsumerNote, ConsumerPeriod,
  ConsumerPoint, ConsumerProfile, ConsumerReadApi, ConsumerSeries, ConsumerSource, MarketHistory,
} from '../../../../contracts/consumer.ts';
import { demoActors, demoScenarioFixtures } from '../../../../contracts/fixtures/consumer/catalog.ts';
import type { DemoCallFixture, DemoScenarioFixture } from '../../../../contracts/fixtures/consumer/catalog.ts';
import { exampleAvatarUrl } from '../media/exampleAvatar.ts';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DAYS = 35;
const HOURS = DAYS * 24;
export const DEMO_AS_OF_MS = Date.parse('2026-10-12T12:00:00.000Z');
export const DEMO_MARKET_PREFIX = 'demo:market:';
const START_MS = DEMO_AS_OF_MS - DAYS * DAY_MS;
const SOURCE: ConsumerSource = {
  mode: 'DEMO',
  label: 'Sample history · fictional activity and generated values · no external feed',
  asOfMs: DEMO_AS_OF_MS,
};

const marketId = (slug: string) => `${DEMO_MARKET_PREFIX}${slug}`;
const atHour = (hour: number) => START_MS + hour * HOUR_MS;
const atDay = (day: number) => atHour(day * 24);
const periodDays = (period: ConsumerPeriod) => period === '1D' ? 1 : period === '1W' ? 7 : period === '1M' ? 30 : DAYS;
const atMsInWindow = (atMs: number, period: ConsumerPeriod) => {
  return atMs >= DEMO_AS_OF_MS - periodDays(period) * DAY_MS && atMs <= DEMO_AS_OF_MS;
};
const decimal = (value: number) => value.toFixed(6);
const fraction = (exit: string, entry: string) => Number((Number(exit) / Number(entry) - 1).toFixed(12));

/** Stable per-series phase. Harmonics make intraday history synthetic, reproducible and non-linear. */
function phaseOf(slug: string): number {
  let hash = 2166136261;
  for (const code of slug) {
    hash ^= code.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff * Math.PI * 2;
}

function syntheticValue(anchors: readonly number[], slug: string, hour: number): number {
  if (hour === HOURS) return anchors[5];
  const week = Math.floor(hour / (7 * 24));
  const t = (hour % (7 * 24)) / (7 * 24);
  const baseline = anchors[week] + (anchors[week + 1] - anchors[week]) * t;
  const phase = phaseOf(slug);
  const texture = 0.023 * Math.sin(2 * Math.PI * hour / 29 + phase)
    + 0.011 * Math.sin(2 * Math.PI * hour / 11 + phase * 0.61);
  return baseline * (1 + Math.sin(Math.PI * t) * texture);
}

function missingAt(scenario: DemoScenarioFixture, hour: number): boolean {
  return (scenario.missingDays ?? []).some(day => hour >= day * 24 && hour < (day + 1) * 24);
}

function valueAt(scenario: DemoScenarioFixture, kind: 'h' | 'price', hour: number): string {
  const h = Number(decimal(syntheticValue(scenario.h, scenario.slug, hour)));
  const value = kind === 'h' ? h : scenario.phase === 'POOL'
    ? h * scenario.priceScale! : syntheticValue(scenario.curvePrice!, `${scenario.slug}:price`, hour);
  return decimal(value);
}

/** Generate only the requested resolution: 1h / 1h / 6h / 24h for 1D / 1W / 1M / ALL. */
function pointsFor(scenario: DemoScenarioFixture, kind: 'h' | 'price', period: ConsumerPeriod): ConsumerPoint[] {
  const stepHours = period === '1D' || period === '1W' ? 1 : period === '1M' ? 6 : 24;
  const startHour = HOURS - periodDays(period) * 24;
  const points: ConsumerPoint[] = [];
  for (let hour = startHour; hour <= HOURS; hour += stepHours) {
    if (missingAt(scenario, hour)) continue;
    points.push({ atMs: atHour(hour), value: valueAt(scenario, kind, hour),
      observationId: `demo:synthetic-point:${scenario.slug}:${kind}:${hour}` });
  }
  return points;
}

function gapsFor(scenario: DemoScenarioFixture, period: ConsumerPeriod): ConsumerSeries['gaps'] {
  const missing = [...new Set(scenario.missingDays ?? [])].sort((a, b) => a - b);
  const gaps: ConsumerSeries['gaps'] = [];
  const fromWindow = DEMO_AS_OF_MS - periodDays(period) * DAY_MS;
  for (const day of missing) {
    const last = gaps[gaps.length - 1];
    if (last && last.toMs === atDay(day)) last.toMs = atDay(day + 1);
    else gaps.push({ fromMs: atDay(day), toMs: atDay(day + 1) });
  }
  return gaps.filter(gap => gap.toMs > fromWindow && gap.fromMs < DEMO_AS_OF_MS)
    .map(gap => ({ fromMs: Math.max(gap.fromMs, fromWindow), toMs: Math.min(gap.toMs, DEMO_AS_OF_MS) }));
}

function noteFor(actionId: string, actorId: string, body: string | undefined, atMs: number, delayDays = 0): ConsumerNote | null {
  if (!body) return null;
  const createdAtMs = atMs + delayDays * DAY_MS;
  if (createdAtMs > DEMO_AS_OF_MS) throw new Error(`Demo note lies after scenario as-of: ${actionId}`);
  return {
    id: `demo:note:${actionId}`, actionId, authorId: actorId,
    body,
    createdAtMs, updatedAtMs: createdAtMs, version: 1,
    timing: delayDays > 0 ? 'ADDED_LATER' : 'AT_ACTION', proofCoverage: 'NONE',
  };
}

function actionsFor(scenario: DemoScenarioFixture): ConsumerAction[] {
  const actions: ConsumerAction[] = [];
  scenario.calls.forEach((call: DemoCallFixture, index) => {
    const actor = demoActors.find(candidate => candidate.id === `demo:wallet:${call.actor}`);
    if (!actor) throw new Error(`Unknown demo actor: ${call.actor}`);
    if (call.openDay < 0 || call.openDay > DAYS || missingAt(scenario, call.openDay * 24))
      throw new Error(`Missing demo entry: ${scenario.slug}:${index}`);
    const entryAtMs = atDay(call.openDay);
    const entryValue = valueAt(scenario, 'h', call.openDay * 24);
    const recordId = `demo:record:${scenario.slug}:${index + 1}`;
    const openId = `demo:action:${scenario.slug}:${index + 1}:open`;
    const shared = { marketId: marketId(scenario.slug), actorId: actor.id, actorLabel: actor.label,
      actorAvatarUrl: exampleAvatarUrl(actor.id),
      seriesId: `demo:series:${scenario.slug}:h`, recordId, source: SOURCE };
    actions.push({ ...shared, id: openId, kind: 'CALL_OPEN', atMs: entryAtMs, value: entryValue,
      returnFraction: null, note: noteFor(openId, actor.id, call.openNote, entryAtMs, call.noteDelayDays) });
    if (call.closeDay === null) return;
    if (call.closeDay <= call.openDay || call.closeDay > DAYS || missingAt(scenario, call.closeDay * 24))
      throw new Error(`Missing demo exit: ${scenario.slug}:${index}`);
    const exitAtMs = atDay(call.closeDay);
    const exitValue = valueAt(scenario, 'h', call.closeDay * 24);
    const closeId = `demo:action:${scenario.slug}:${index + 1}:close`;
    actions.push({ ...shared, id: closeId, kind: 'CALL_CLOSE', atMs: exitAtMs, value: exitValue,
      returnFraction: fraction(exitValue, entryValue), note: noteFor(closeId, actor.id, call.closeNote, exitAtMs) });
  });
  return actions.sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
}

interface BuiltMarket { market: ConsumerMarket; scenario: DemoScenarioFixture; actions: ConsumerAction[]; }
function buildMarket(scenario: DemoScenarioFixture): BuiltMarket {
  if (scenario.h.length !== 6 || scenario.h.some(value => value <= 0 || value > 5)) throw new Error(`Invalid demo h anchors: ${scenario.slug}`);
  if (scenario.phase === 'POOL' && !scenario.priceScale) throw new Error(`Missing demo price scale: ${scenario.slug}`);
  if (scenario.phase === 'CURVE' && (!scenario.curvePrice || scenario.curvePrice.length !== 6)) throw new Error(`Missing demo curve quotes: ${scenario.slug}`);
  const latestPrice = scenario.phase === 'PREVIEW' ? null : valueAt(scenario, 'price', HOURS);
  const weekAgo = scenario.phase === 'PREVIEW' ? null : valueAt(scenario, 'price', HOURS - 7 * 24);
  const changeFraction = latestPrice && weekAgo ? fraction(latestPrice, weekAgo) : null;
  return {
    market: { id: marketId(scenario.slug), title: scenario.title, subtitle: scenario.subtitle,
      subject: scenario.subject, phase: scenario.phase, source: SOURCE, latestPrice,
      priceUnit: 'sample units', changeFraction,
      subjectUrl: scenario.subjectUrl, creatorLabel: scenario.creatorLabel,
      thumbnailUrl: scenario.imageUrl, imageAlt: scenario.imageAlt, imageSourceUrl: scenario.imageSourceUrl },
    scenario, actions: actionsFor(scenario),
  };
}

function seriesFor(scenario: DemoScenarioFixture, period: ConsumerPeriod): ConsumerSeries[] {
  const gaps = gapsFor(scenario, period);
  const series: ConsumerSeries[] = [{ id: `demo:series:${scenario.slug}:h`, kind: 'ATTENTION_INDEX',
    label: 'Attention index', unit: '×', points: pointsFor(scenario, 'h', period), gaps, source: SOURCE }];
  if (scenario.phase !== 'PREVIEW') series.push({ id: `demo:series:${scenario.slug}:price`,
    kind: scenario.phase === 'POOL' ? 'REFERENCE_PRICE' : 'CURVE_PRICE',
    label: 'Sample price',
    unit: 'sample units', points: pointsFor(scenario, 'price', period), gaps: gapsFor(scenario, period), source: SOURCE });
  return series;
}

const built = demoScenarioFixtures.map(buildMarket);
const byMarket = new Map(built.map(item => [item.market.id, item]));
const allActions = built.flatMap(item => item.actions);
const actorById = new Map<string, { id: string; label: string }>(demoActors.map(actor => [actor.id, actor]));
const copy = <T>(value: T): T => structuredClone(value);

export function isDemoConsumerId(id: string): boolean { return id.startsWith('demo:'); }

/** Read-only synthetic provider. It has no wallet, storage, network, quote or execution dependency. */
export function createDemoConsumerReadApi(): ConsumerReadApi {
  return {
    async listMarkets() { return copy(built.map(item => item.market)); },
    async getHistory(id, period) {
      const item = byMarket.get(id);
      if (!item) return null;
      const history: MarketHistory = { market: item.market, period, source: SOURCE,
        series: seriesFor(item.scenario, period),
        actions: item.actions.filter(action => atMsInWindow(action.atMs, period)),
      };
      return copy(history);
    },
    async getProfile(actorId) {
      const actor = actorById.get(actorId);
      if (!actor) return null;
      const actions = allActions.filter(action => action.actorId === actorId).sort((a, b) => b.atMs - a.atMs || a.id.localeCompare(b.id));
      const closed = actions.filter(action => action.kind === 'CALL_CLOSE' && action.returnFraction !== null);
      const profile: ConsumerProfile = { actorId, actorLabel: actor.label, source: SOURCE,
        avatarUrl: exampleAvatarUrl(actorId), avatarAlt: `Generated avatar for ${actor.label}`,
        closedCallCount: closed.length, openCallCount: actions.filter(action => action.kind === 'CALL_OPEN').length - closed.length,
        meanReturnFraction: closed.length ? Number((closed.reduce((sum, action) => sum + action.returnFraction!, 0) / closed.length).toFixed(12)) : null,
        actions };
      return copy(profile);
    },
    async getLeaderboard(period) {
      const closed = allActions.filter(action => action.kind === 'CALL_CLOSE' && action.returnFraction !== null &&
        (period === 'ALL' || action.atMs >= DEMO_AS_OF_MS - 7 * DAY_MS));
      const rows = demoActors.flatMap(actor => {
        const calls = closed.filter(action => action.actorId === actor.id);
        return calls.length ? [{ actorId: actor.id, actorLabel: actor.label, closedCallCount: calls.length,
          meanReturnFraction: Number((calls.reduce((sum, action) => sum + action.returnFraction!, 0) / calls.length).toFixed(12)), rank: 0 }] : [];
      }).sort((a, b) => b.meanReturnFraction - a.meanReturnFraction || a.actorId.localeCompare(b.actorId));
      rows.forEach((row, index) => { row.rank = index && row.meanReturnFraction === rows[index - 1].meanReturnFraction ? rows[index - 1].rank : index + 1; });
      const board: ConsumerLeaderboard = { period, source: SOURCE, rows };
      return copy(board);
    },
  };
}

export const demoConsumerReadApi = createDemoConsumerReadApi();
