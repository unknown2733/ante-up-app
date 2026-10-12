/** Local browser QA fixture. All routes are reads; it never returns synthetic LIVE history. */
import { demoConsumerReadApi } from '../../src/demo/consumerDemo.ts';
import { fixtureMarkets, fixtureProofs, fixtureRecords, heldCalculationWallets } from '../../../../services/api/src/fixture.ts';
import { leaderboard, profile } from '../../../../services/api/src/leaderboard.ts';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'x-ante-qa-mock': 'read-only',
} });
const envelope = (data, asOf, nextCursor = null, mode = 'fixture') => ({ schemaVersion: '0.1', mode, asOf, data, nextCursor });
const bad = (code, message, status = 400) => json({ code, message, retryable: false, requestId: null }, status);
const name = part => { try { return decodeURIComponent(part); } catch { return null; } };
const demoSource = () => ({ mode: 'LIVE', label: 'QA empty Live stub · no observations', asOfMs: Date.now() });
const emptyLegacyHistory = (period, asOf) => {
  const source = { mode: 'LIVE', label: 'Local QA fixture · no observations', asOfMs: asOf * 1000 };
  return { market: { id: 'fixture:sol', title: 'QA fixture: solana', subtitle: 'Disconnected legacy route check',
    subject: 'KEYWORD', phase: 'CURVE', source, latestPrice: null, priceUnit: 'tUSD', changeFraction: null,
    liveMarketId: 'fixture:sol' }, period, series: [], actions: [], source };
};

export async function handleReadonlyMock(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return bad('UNAUTHORIZED', 'Read-only QA server. No writes are accepted.', 405);
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'v1') return bad('INVALID_INPUT', 'Unknown QA route.', 404);
  const asOf = Math.floor(Date.now() / 1000);
  const records = fixtureRecords(asOf);
  const markets = structuredClone(fixtureMarkets);
  if (markets[0]?.snapshot) {
    markets[0].snapshot.payload.dataThrough = asOf - 60;
    markets[0].snapshot.payload.computedAt = asOf - 45;
    markets[0].snapshot.publishedAt = asOf - 30;
  }
  if (parts[1] === 'consumer') {
    const demo = url.searchParams.get('mode') === 'DEMO';
    const consumerEnvelope = data => envelope(data, asOf, null, demo ? 'fixture' : 'devnet');
    if (parts[2] === 'markets' && parts.length === 3) {
      const data = demo ? await demoConsumerReadApi.listMarkets() : [];
      return json(consumerEnvelope(data));
    }
    if (parts[2] === 'markets' && parts[4] === 'history') {
      const period = url.searchParams.get('period') ?? 'ALL';
      if (!['1D','1W','1M','ALL'].includes(period)) return bad('INVALID_INPUT', 'Invalid period.');
      const id = name(parts[3]);
      const data = demo && id?.startsWith('demo:') ? await demoConsumerReadApi.getHistory(id, period)
        : !demo && id === 'fixture:sol' ? emptyLegacyHistory(period, asOf) : null;
      return json(consumerEnvelope(data));
    }
    if (parts[2] === 'profiles' && parts[3]) {
      const id = name(parts[3]);
      const data = demo && id?.startsWith('demo:') ? await demoConsumerReadApi.getProfile(id) : null;
      return json(consumerEnvelope(data));
    }
    if (parts[2] === 'leaderboard') {
      const period = url.searchParams.get('period') ?? 'ALL';
      if (!['7D','ALL'].includes(period)) return bad('INVALID_INPUT', 'Invalid period.');
      const data = demo ? await demoConsumerReadApi.getLeaderboard(period)
        : { period, source: demoSource(), rows: [] };
      return json(consumerEnvelope(data));
    }
    if (parts[2] === 'notes' && parts[3]) {
      const id = name(parts[3]);
      const markets = demo ? await demoConsumerReadApi.listMarkets() : [];
      let note = null;
      for (const market of markets) {
        const history = await demoConsumerReadApi.getHistory(market.id, 'ALL');
        note = history.actions.find(action => action.id === id)?.note ?? null;
        if (note) break;
      }
      return json(consumerEnvelope({ note, revisions: note ? [{ ...note, revisedAtMs: note.updatedAtMs }] : [] }));
    }
    return bad('INVALID_INPUT', 'Unknown consumer QA route.', 404);
  }
  if (parts[1] === 'markets' && parts.length === 2) return json(envelope(markets, asOf));
  if (parts[1] === 'markets' && parts[2]) {
    const market = markets.find(item => item.id === name(parts[2]));
    if (!market) return bad('INVALID_INPUT', 'Market not found.');
    if (parts[3] === 'snapshots') return json(envelope(market.snapshot ? [market.snapshot] : [], asOf));
    if (parts.length === 3) return json(envelope(market, asOf));
  }
  if (parts[1] === 'records' && parts[2]) {
    const record = records.find(item => item.id === name(parts[2]));
    return record ? json(envelope(record, asOf)) : bad('INVALID_INPUT', 'Record not found.');
  }
  if (parts[1] === 'proofs' && parts[2]) return json(envelope(fixtureProofs.find(item => item.id === name(parts[2])) ?? null, asOf));
  if (parts[1] === 'profiles' && parts[2]) {
    const data = profile(records, name(parts[2]), heldCalculationWallets);
    const openPreviews = data.openRecords.map(record => ({ recordId: record.id, referenceReturn: null, status: 'UNAVAILABLE', observedAt: null }));
    return json(envelope({ ...data, openPreviews }, asOf));
  }
  if (parts[1] === 'leaderboard') {
    const period = url.searchParams.get('period') ?? '7d';
    if (!['7d','all'].includes(period)) return bad('INVALID_INPUT', 'Invalid period.');
    return json(envelope(leaderboard(records, period, asOf, heldCalculationWallets), asOf));
  }
  if (parts[1] === 'financial') return bad('UNAUTHORIZED', 'QA fixture has no financial account.', 403);
  return bad('INVALID_INPUT', 'Unknown QA route.', 404);
}
