/** Read-only assertions for the additive ConsumerReadApi snapshot. No wallet or network calls. */
const decimal = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const decimalString = value => typeof value === 'string' && decimal.test(value);
const modes = new Set(['LIVE', 'DEMO']);
const kinds = new Set(['CURVE_PRICE', 'REFERENCE_PRICE', 'TRADE_PRICE', 'ATTENTION_INDEX']);
const subjects = new Set(['KEYWORD', 'VIDEO', 'TRACK', 'ALBUM', 'ACCOUNT', 'POST']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const epoch = value => Number.isInteger(value) && value > 1_500_000_000_000 && value < 10_000_000_000_000;
const str = value => typeof value === 'string' && value.length > 0;
const sameNumber = (left, right) => left === right || (finite(left) && finite(right) && Math.abs(left - right) <= 1e-9);
const actionFields = ['marketId', 'actorId', 'kind', 'atMs', 'recordId'];

function sameAction(left, right) {
  if (actionFields.some(field => left[field] !== right[field])) return false;
  if (!sameNumber(left.returnFraction, right.returnFraction) || left.source?.mode !== right.source?.mode) return false;
  if (left.note === null || right.note === null) {
    if (left.note !== right.note) return false;
  } else if (JSON.stringify(left.note) !== JSON.stringify(right.note)) return false;
  // Social has no verified point; chart may add a series/value pair.
  if (left.value !== null && right.value !== null && left.value !== right.value) return false;
  if (left.seriesId !== null && right.seriesId !== null && left.seriesId !== right.seriesId) return false;
  return true;
}

export function auditConsumerSnapshot(snapshot) {
  const issues = [];
  const fail = (path, message) => issues.push({ path, message });
  const source = (item, path, expectedMode) => {
    const s = item?.source;
    if (!s || !modes.has(s.mode) || !str(s.label) || !epoch(s.asOfMs)) fail(`${path}.source`, 'mode, label and epoch-ms asOfMs are required');
    else if (expectedMode && s.mode !== expectedMode) fail(`${path}.source.mode`, `expected ${expectedMode}`);
    return s?.mode;
  };
  const markets = snapshot?.markets;
  if (!Array.isArray(markets)) return [{ path: 'markets', message: 'markets array required' }];
  const marketById = new Map();
  for (const [i, m] of markets.entries()) {
    const p = `markets[${i}]`;
    const mode = source(m, p);
    if (!str(m?.id) || marketById.has(m.id)) fail(`${p}.id`, 'unique opaque id required');
    else marketById.set(m.id, m);
    if (!str(m?.title) || !subjects.has(m?.subject)) fail(p, 'title and known subject required');
    if (m?.latestPrice !== null && !decimalString(m?.latestPrice)) fail(`${p}.latestPrice`, 'decimal string or null required');
    if (m?.changeFraction !== null && !finite(m?.changeFraction)) fail(`${p}.changeFraction`, 'finite fraction or null required');
    if (mode === 'DEMO' && m?.liveMarketId) fail(`${p}.liveMarketId`, 'demo market cannot claim a live market id');
  }
  const histories = snapshot?.histories ?? [];
  if (!Array.isArray(histories)) fail('histories', 'array required');
  const actionById = new Map();
  for (const [i, h] of (Array.isArray(histories) ? histories : []).entries()) {
    const p = `histories[${i}]`;
    const mode = source(h, p);
    const m = marketById.get(h?.market?.id);
    if (!m || m.source.mode !== mode || h.market.source.mode !== mode) fail(`${p}.market`, 'market must match snapshot and history mode');
    if (!['1D', '1W', '1M', 'ALL'].includes(h?.period)) fail(`${p}.period`, 'unknown period');
    const seriesById = new Map();
    for (const [j, s] of (h?.series ?? []).entries()) {
      const q = `${p}.series[${j}]`;
      source(s, q, mode);
      if (!str(s?.id) || seriesById.has(s.id)) fail(`${q}.id`, 'unique series id required');
      else seriesById.set(s.id, s);
      if (!kinds.has(s?.kind) || !str(s?.label) || !str(s?.unit)) fail(q, 'kind, label and unit required');
      let previous = -Infinity;
      for (const [k, point] of (s?.points ?? []).entries()) {
        if (!epoch(point.atMs) || point.atMs <= previous) fail(`${q}.points[${k}].atMs`, 'strictly increasing epoch-ms required');
        previous = point.atMs;
        if (!decimalString(point.value)) fail(`${q}.points[${k}].value`, 'decimal string required');
      }
      for (const [k, gap] of (s?.gaps ?? []).entries()) {
        if (!epoch(gap.fromMs) || !epoch(gap.toMs) || gap.fromMs >= gap.toMs) fail(`${q}.gaps[${k}]`, 'positive epoch-ms interval required');
        if ((s?.points ?? []).some(point => point.atMs > gap.fromMs && point.atMs < gap.toMs)) fail(`${q}.gaps[${k}]`, 'gap interior contains a plotted point');
      }
      if (mode === 'DEMO' && h.period === '1D') {
        const start = h.source.asOfMs - 86_400_000;
        const gapMs = (s.gaps ?? []).reduce((sum, gap) => sum + Math.max(0, Math.min(h.source.asOfMs, gap.toMs) - Math.max(start, gap.fromMs)), 0);
        const required = Math.ceil(Math.max(0, 86_400_000 - Math.min(86_400_000, gapMs)) / 3_600_000);
        if ((s.points ?? []).length < required) fail(`${q}.points`, `Demo 1D requires at least ${required} intraday points outside explicit gaps`);
      }
    }
    for (const [j, a] of (h?.actions ?? []).entries()) {
      const q = `${p}.actions[${j}]`;
      source(a, q, mode);
      if (!str(a?.id)) fail(`${q}.id`, 'opaque action id required');
      else if (actionById.has(a.id) && !sameAction(actionById.get(a.id), a)) fail(`${q}.id`, 'same action ID differs across periods');
      else actionById.set(a.id, a);
      if (a?.marketId !== h.market.id || !epoch(a?.atMs) || !str(a?.actorId)) fail(q, 'market, actor and epoch-ms action time required');
      if (!['CALL_OPEN', 'CALL_CLOSE', 'BUY', 'SELL'].includes(a?.kind)) fail(`${q}.kind`, 'unknown action kind');
      if (a?.value !== null && !decimalString(a?.value)) fail(`${q}.value`, 'decimal string or null required');
      if (a?.seriesId !== null && !seriesById.has(a?.seriesId)) fail(`${q}.seriesId`, 'series must exist in this history');
      if (a?.value !== null && a?.seriesId === null) fail(`${q}.seriesId`, 'valued marker needs a labeled series');
      if (a?.returnFraction !== null && !finite(a?.returnFraction)) fail(`${q}.returnFraction`, 'finite fraction or null required');
      if (a?.kind === 'CALL_OPEN' && a?.returnFraction !== null) fail(`${q}.returnFraction`, 'open call has no settled return');
      if (a?.note) {
        const n = a.note;
        if (n.actionId !== a.id || n.authorId !== a.actorId) fail(`${q}.note`, 'note must belong to the action and actor');
        if (!str(n.body) || [...n.body].length > 280) fail(`${q}.note.body`, 'text of 1–280 Unicode code points required');
        if (!epoch(n.createdAtMs) || !epoch(n.updatedAtMs) || n.updatedAtMs < n.createdAtMs) fail(`${q}.note`, 'valid server timestamps and edit order required');
        if (!Number.isInteger(n.version) || n.version < 1 || n.proofCoverage !== 'NONE') fail(`${q}.note`, 'positive version and NONE proof coverage required');
        if (n.timing === 'ADDED_LATER' && n.createdAtMs <= a.atMs) fail(`${q}.note.timing`, 'later note must postdate action');
        if (!['AT_ACTION', 'ADDED_LATER'].includes(n.timing)) fail(`${q}.note.timing`, 'known timing label required');
        if (n.version > 1 && n.updatedAtMs === n.createdAtMs) fail(`${q}.note.version`, 'edited note requires later updatedAtMs');
      }
    }
  }
  const profiles = snapshot?.profiles ?? [];
  for (const [i, profile] of profiles.entries()) {
    const p = `profiles[${i}]`;
    const mode = source(profile, p);
    if (!str(profile.actorId) || !Number.isInteger(profile.closedCallCount) || profile.closedCallCount < 0 || !Number.isInteger(profile.openCallCount) || profile.openCallCount < 0) fail(p, 'actor and nonnegative counts required');
    if (profile.meanReturnFraction !== null && !finite(profile.meanReturnFraction)) fail(`${p}.meanReturnFraction`, 'finite fraction or null required');
    if (profile.closedCallCount === 0 && profile.meanReturnFraction !== null) fail(`${p}.meanReturnFraction`, 'N/A requires null');
    const known = [];
    for (const [j, action] of (profile.actions ?? []).entries()) {
      const canonical = actionById.get(action.id);
      if (!canonical || canonical.actorId !== profile.actorId || canonical.source.mode !== mode) fail(`${p}.actions[${j}]`, 'action must match history, actor and mode');
      if (mode === 'LIVE' && ['BUY', 'SELL'].includes(action.kind)) fail(`${p}.actions[${j}]`, 'public live profile exposes paid activity');
      if (canonical && !sameAction(action, canonical)) fail(`${p}.actions[${j}]`, 'profile action differs from chart action');
      if (action.kind === 'CALL_CLOSE' && finite(action.returnFraction)) known.push(action.returnFraction);
    }
    if (known.length === profile.closedCallCount && known.length > 0 && Math.abs(known.reduce((a,b)=>a+b,0)/known.length - profile.meanReturnFraction) > 1e-9) fail(`${p}.meanReturnFraction`, 'must equal arithmetic mean of valid closed calls');
  }
  // Demo closed-call performance is the h/attention ratio at the two action times.
  for (const [i, h] of (Array.isArray(histories) ? histories : []).entries()) {
    if (h.source?.mode !== 'DEMO' || h.period !== 'ALL') continue;
    const byRecord = Map.groupBy(h.actions ?? [], action => action.recordId);
    for (const actions of byRecord.values()) {
      const open = actions.find(action => action.kind === 'CALL_OPEN');
      const close = actions.find(action => action.kind === 'CALL_CLOSE');
      if (!open || !close || close.returnFraction === null) continue;
      const attention = (h.series ?? []).find(series => series.id === open.seriesId && series.kind === 'ATTENTION_INDEX');
      if (!attention || close.seriesId !== attention.id) continue;
      const entry = Number(open.value);
      const exit = Number(close.value);
      if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0 || !sameNumber(close.returnFraction, exit / entry - 1))
        fail(`histories[${i}].actions`, `Demo return for ${close.recordId} differs from attention at entry and exit`);
    }
  }
  const boards = snapshot?.leaderboards ?? [];
  for (const [i, board] of boards.entries()) {
    const p = `leaderboards[${i}]`;
    const mode = source(board, p);
    if (!['7D', 'ALL'].includes(board.period)) fail(`${p}.period`, 'unknown period');
    let previous = Infinity;
    let previousRank = 0;
    const rankedActors = new Set();
    for (const [j, row] of (board.rows ?? []).entries()) {
      const q = `${p}.rows[${j}]`;
      if (!str(row.actorId) || !Number.isInteger(row.closedCallCount) || row.closedCallCount < 1 || !finite(row.meanReturnFraction) || !Number.isInteger(row.rank) || row.rank < 1) fail(q, 'ranked actor needs valid closed calls and finite score');
      if (row.meanReturnFraction > previous) fail(q, 'rows must be sorted descending');
      if (rankedActors.has(row.actorId)) fail(`${q}.actorId`, 'actor appears twice in one board');
      rankedActors.add(row.actorId);
      if (row.rank !== (row.meanReturnFraction === previous ? previousRank : j + 1)) fail(`${q}.rank`, 'competition rank must preserve ties');
      previous = row.meanReturnFraction;
      previousRank = row.rank;
      const profile = profiles.find(x => x.actorId === row.actorId && x.source.mode === mode);
      if (profile && board.period === 'ALL' && (profile.meanReturnFraction === null || Math.abs(profile.meanReturnFraction - row.meanReturnFraction) > 1e-9)) fail(q, 'all-time rank differs from profile score');
    }
  }
  return issues;
}
