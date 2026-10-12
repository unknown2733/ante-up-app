import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ConsumerAction, ConsumerLeaderboard, ConsumerNote, ConsumerProfile } from '../../../../contracts/consumer';
import './social.css';

const date = (atMs: number) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(atMs) + ' UTC';
const percent = (value: number | null) => value === null || !Number.isFinite(value) ? 'N/A' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
const shortActor = (actor: string) => actor.length > 18 ? `${actor.slice(0, 7)}…${actor.slice(-5)}` : actor;
const freeActions = (actions: ConsumerAction[]) => actions.filter(action => action.source.mode === 'DEMO' || action.kind === 'CALL_OPEN' || action.kind === 'CALL_CLOSE');

export function SocialLeaderboard({ board, onOpenProfile }: {
  board: ConsumerLeaderboard; onOpenProfile: (actorId: string) => void;
}) {
  return <section className="au-social" aria-label="Free call leaderboard">
    <header className="au-social-heading"><div><span className="au-social-kicker">THE BOARD</span><h2>Free call leaderboard</h2></div><span className="au-social-source">{board.source.label}</span></header>
    <p className="au-social-explain">Average return across valid closed free calls. Open calls and N/A results are not ranked. This is not a money P&amp;L ranking.</p>
    <p className="au-social-period">{board.period === '7D' ? 'Last 7 days · by close time' : 'All time'} · {board.source.mode === 'DEMO' ? 'Demo' : 'Live Devnet'}</p>
    {board.rows.length === 0 ? <p className="au-social-empty">No valid closed calls in this period yet.</p> :
      <ol className="au-social-ranks">{board.rows.map(row => <li key={row.actorId}>
        <span className="au-social-rank">{String(row.rank).padStart(2, '0')}</span>
        <button type="button" className="au-social-actor" onClick={() => onOpenProfile(row.actorId)} aria-label={`Open ${row.actorLabel || shortActor(row.actorId)} profile`}>
          <strong>{row.actorLabel || shortActor(row.actorId)}</strong><small>{row.closedCallCount} valid closed {row.closedCallCount === 1 ? 'call' : 'calls'}</small>
        </button>
        <strong className={row.meanReturnFraction < 0 ? 'au-social-negative' : 'au-social-positive'}>{percent(row.meanReturnFraction)}</strong>
      </li>)}</ol>}
  </section>;
}

export function SocialProfile({ profile, onOpenMarket, onOpenAction, onOpenProfile, noteEditor, marketLabel }: {
  profile: ConsumerProfile;
  onOpenMarket: (marketId: string) => void;
  onOpenAction: (action: ConsumerAction) => void;
  onOpenProfile?: (actorId: string) => void;
  noteEditor?: (action: ConsumerAction) => ReactNode;
  marketLabel?: (marketId: string) => string;
}) {
  const actions = freeActions(profile.actions).sort((a, b) => b.atMs - a.atMs || a.id.localeCompare(b.id));
  const naCount = actions.filter(action => action.kind === 'CALL_CLOSE' && action.returnFraction === null).length;
  return <section className="au-social" aria-label={`${profile.actorLabel || shortActor(profile.actorId)} public profile`}>
    <header className="au-social-heading"><div><span className="au-social-kicker">PUBLIC PROFILE</span><h2>{profile.actorLabel || shortActor(profile.actorId)}</h2><small>{shortActor(profile.actorId)}</small></div><span className="au-social-source">{profile.source.label}</span></header>
    <p className="au-social-explain">{profile.source.mode === 'DEMO' ? 'Synthetic demo activity. No real wallet, trade or proof is implied.' : 'Public free calls only. Open calls are shown for context; paid positions, Pro and Liquidity are outside this profile.'}</p>
    <dl className="au-social-stats"><div><dt>Valid closed average</dt><dd>{percent(profile.meanReturnFraction)}</dd></div><div><dt>Valid closed calls</dt><dd>{profile.closedCallCount}</dd></div><div><dt>N/A closes</dt><dd>{naCount}</dd></div><div><dt>Open calls</dt><dd>{profile.openCallCount}</dd></div></dl>
    <h3>{profile.source.mode === 'DEMO' ? 'Activity history' : 'Call history'}</h3>
    {actions.length === 0 ? <p className="au-social-empty">No public free calls yet.</p> :
      <ol className="au-social-actions">{actions.map(action => <li key={action.id}>
        <div className="au-social-action-head"><span>{action.kind === 'CALL_OPEN' ? 'Call opened' : action.kind === 'CALL_CLOSE' ? 'Call closed' : action.kind}</span><time dateTime={new Date(action.atMs).toISOString()}>{date(action.atMs)}</time></div>
        <div className="au-social-action-main"><button type="button" onClick={() => onOpenMarket(action.marketId)}>{marketLabel?.(action.marketId) ?? action.marketId} ↗</button><strong className={action.returnFraction === null ? '' : action.returnFraction < 0 ? 'au-social-negative' : 'au-social-positive'}>{action.kind === 'CALL_OPEN' ? 'Open' : percent(action.returnFraction)}</strong></div>
        {action.note && <SocialNote note={action.note} />}
        {noteEditor?.(action)}
        <div className="au-social-links"><button type="button" onClick={() => onOpenAction(action)}>See call on chart ↗</button>{onOpenProfile && <button type="button" onClick={() => onOpenProfile(action.actorId)}>Wallet ↗</button>}</div>
      </li>)}</ol>}
  </section>;
}

export function SocialNote({ note, showHistory }: { note: ConsumerNote; showHistory?: () => void }) {
  return <aside className="au-social-note" aria-label="Call note"><p>{note.body}</p><div>
    <span>{note.timing === 'ADDED_LATER' ? 'Added later' : 'Written at action'}</span>
    <time dateTime={new Date(note.createdAtMs).toISOString()}>{date(note.createdAtMs)}</time>
    {note.version > 1 && <span>Edited · v{note.version}</span>}
    {showHistory && note.version > 1 && <button type="button" onClick={showHistory}>Edit history</button>}
    <span>Not covered by SAS proof</span>
  </div></aside>;
}

export function SocialNoteHistory({ revisions }: { revisions: Array<ConsumerNote & { revisedAtMs: number }> }) {
  return <section className="au-social-history" aria-label="Note edit history"><h4>Note history</h4>
    <ol>{revisions.map(revision => <li key={revision.version}><div><strong>Version {revision.version}</strong><time dateTime={new Date(revision.revisedAtMs).toISOString()}>{date(revision.revisedAtMs)}</time></div>
      <p>{revision.body}</p></li>)}</ol><small>These notes are not covered by SAS proof.</small></section>;
}

export interface SocialNoteWriter {
  save(actionId: string, body: string, expectedVersion: number): Promise<ConsumerNote>;
}

export function SocialNoteEditor({ action, wallet, writer, onSaved }: {
  action: ConsumerAction; wallet: string | null; writer: SocialNoteWriter;
  onSaved?: (note: ConsumerNote) => void;
}) {
  const [draft, setDraft] = useState(action.note?.body ?? '');
  const [current, setCurrent] = useState(action.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  if (!wallet || wallet !== action.actorId || (action.source.mode === 'LIVE' && action.kind !== 'CALL_OPEN' && action.kind !== 'CALL_CLOSE')) return null;
  const count = [...draft].length;
  return <form className="au-social-editor" onSubmit={async event => {
    event.preventDefault();
    if (saving || count < 1 || count > 280 || !draft.trim()) return;
    setSaving(true); setError('');
    try { const saved = await writer.save(action.id, draft, current?.version ?? 0); setCurrent(saved); onSaved?.(saved); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save note.'); }
    finally { setSaving(false); }
  }}>
    <label htmlFor={`au-note-${action.id}`}>{current ? 'Edit your call note' : 'Add a call note'}</label>
    <textarea id={`au-note-${action.id}`} value={draft} onChange={event => setDraft(event.target.value)} maxLength={560} rows={3} placeholder="What informed your call?" />
    <div className="au-social-editor-footer"><small>{count}/280 characters · Server time · Not covered by SAS proof</small><button type="submit" disabled={saving || count < 1 || count > 280 || !draft.trim()}>{saving ? 'Saving…' : 'Save note'}</button></div>
    {error && <p role="alert">{error}</p>}
  </form>;
}
