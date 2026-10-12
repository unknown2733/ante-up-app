import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ConsumerAction, ConsumerLeaderboard, ConsumerNote, ConsumerProfile } from '../../../../contracts/consumer';
import './social.css';

export interface SocialMarketMedia {
  title: string;
  subtitle?: string;
  thumbnailUrl?: string;
  imageAlt?: string;
}

/** Integration can supply the shared WalletAvatar and SubjectImage components. */
export type SocialAvatarRenderer = (props: { address: string; src?: string; className: string }) => ReactNode;
export type SocialSubjectRenderer = (props: { src?: string; alt: string; className: string }) => ReactNode;

const date = (atMs: number) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(atMs) + ' UTC';
const day = (atMs: number) => new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(atMs);
const time = (atMs: number) => new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(atMs) + ' UTC';
const percent = (value: number | null) => value === null || !Number.isFinite(value) ? 'N/A' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
const shortActor = (actor: string) => actor.length > 18 ? `${actor.slice(0, 7)}…${actor.slice(-5)}` : actor;
const publicActions = (actions: ConsumerAction[]) => actions.filter(action => action.source.mode === 'DEMO' || action.kind === 'CALL_OPEN' || action.kind === 'CALL_CLOSE');
const safeImage = (url?: string) => url && (/^https:\/\/[^\s]+$/i.test(url) || /^\/(?!\/)[^\s]*$/.test(url)) ? url : undefined;
const initials = (label: string) => label.trim().split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase() || '•';

/** A local, fixed SVG template gives every wallet a stable avatar without trusting a data URL from an API. */
function generatedAvatarUrl(address: string) {
  let hash = 2166136261;
  for (const character of address) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const palette = [['#0d5c76', '#68e0cf'], ['#6648a8', '#d3a8ff'], ['#9e4b42', '#ffc39a'], ['#315e9a', '#9bd2ff']] as const;
  const [background, foreground] = palette[(hash >>> 0) % palette.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="${background}"/><circle cx="32" cy="32" r="18" fill="${foreground}"/><circle cx="47" cy="18" r="5" fill="#fff" opacity=".72"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function ImageOrFallback({ url, alt, label, kind, actorId, renderAvatar, renderSubjectImage }: {
  url?: string; alt: string; label: string; kind: 'avatar' | 'subject'; actorId?: string;
  renderAvatar?: SocialAvatarRenderer; renderSubjectImage?: SocialSubjectRenderer;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const externalSrc = safeImage(url);
  const fallbackSrc = kind === 'avatar' ? generatedAvatarUrl(actorId || label) : undefined;
  const src = externalSrc && externalSrc !== failedSrc ? externalSrc : fallbackSrc !== failedSrc ? fallbackSrc : undefined;
  const className = `au-social-image au-social-image--${kind}`;
  if (kind === 'avatar' && renderAvatar) {
    return <span className={className}>{renderAvatar({ address: actorId || label, src: url, className: 'au-social-image-media' })}</span>;
  }
  if (kind === 'subject' && renderSubjectImage) {
    return <span className={className}>{renderSubjectImage({ src: url, alt, className: 'au-social-image-media' })}</span>;
  }
  return <span className={className} aria-hidden={src ? undefined : true}>
    {src ? <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailedSrc(src)} /> : <span aria-hidden="true">{initials(label)}</span>}
  </span>;
}

function actionVerb(action: ConsumerAction) {
  if (action.kind === 'CALL_OPEN') return 'Placed a chip';
  if (action.kind === 'CALL_CLOSE') return 'Took back a chip';
  return action.kind === 'BUY' ? 'Bought' : 'Sold';
}

function ActionResult({ action }: { action: ConsumerAction }) {
  if (action.kind === 'CALL_OPEN') return <span className="au-social-result au-social-result--event">Placement</span>;
  if (action.kind === 'BUY' || action.kind === 'SELL') return <span className="au-social-result">Sample activity</span>;
  return <span className={`au-social-result ${action.returnFraction === null ? '' : action.returnFraction < 0 ? 'au-social-negative' : 'au-social-positive'}`} aria-label={`Return ${percent(action.returnFraction)}`}>{percent(action.returnFraction)}</span>;
}

export function actionDetailMessage(action: ConsumerAction) {
  if (action.kind === 'CALL_OPEN') return 'Placement event. This event does not determine current chip status or final return.';
  if (action.kind === 'CALL_CLOSE' && action.returnFraction === null) return 'A return is unavailable for this close.';
  if (action.kind === 'CALL_CLOSE') return 'Return shown for this closed chip.';
  return 'Sample activity event.';
}

export function SocialLeaderboard({ board, onOpenProfile, avatarByActorId, renderAvatar }: {
  board: ConsumerLeaderboard; onOpenProfile: (actorId: string) => void;
  avatarByActorId?: Record<string, string | undefined>;
  renderAvatar?: SocialAvatarRenderer;
}) {
  return <section className="au-social" aria-label="Leaderboard">
    <header className="au-social-heading"><div><span className="au-social-kicker">COMMUNITY</span><h2>Leaderboard</h2></div><span className="au-social-source">{board.source.mode === 'DEMO' ? 'Example' : 'Devnet'} · {board.source.label}</span></header>
    <p className="au-social-explain">Average return on valid closed chips. N/A closes are excluded. Returns are percentages, not money P&amp;L.</p>
    <p className="au-social-period">{board.period === '7D' ? 'Last 7 days · by close time' : 'All time'} · {board.source.mode === 'DEMO' ? 'Synthetic examples' : 'Public Devnet chips'} · Updated {date(board.source.asOfMs)}</p>
    {board.rows.length === 0 ? <p className="au-social-empty">No valid closed chips in this period yet.</p> :
      <ol className="au-social-ranks">{board.rows.map(row => <li key={row.actorId}>
        <span className="au-social-rank" aria-label={`Rank ${row.rank}`}>{String(row.rank).padStart(2, '0')}</span>
        <button type="button" className="au-social-actor" onClick={() => onOpenProfile(row.actorId)} aria-label={`Open ${row.actorLabel || shortActor(row.actorId)} profile`}>
          <ImageOrFallback url={avatarByActorId?.[row.actorId]} alt="" label={row.actorLabel || row.actorId} actorId={row.actorId} kind="avatar" renderAvatar={renderAvatar} />
          <span><strong>{row.actorLabel || shortActor(row.actorId)}</strong><small>{row.closedCallCount} valid closed {row.closedCallCount === 1 ? 'chip' : 'chips'}</small></span>
        </button>
        <strong className={`au-social-rank-result ${row.meanReturnFraction < 0 ? 'au-social-negative' : 'au-social-positive'}`}>{percent(row.meanReturnFraction)}</strong>
      </li>)}</ol>}
    {board.source.mode === 'DEMO' && <p className="au-social-footnote">Example wallets and results are fictional.</p>}
  </section>;
}

export function SocialProfile({ profile, onOpenMarket, onOpenAction, onOpenProfile, noteEditor, marketLabel, marketMedia, renderAvatar, renderSubjectImage }: {
  profile: ConsumerProfile;
  onOpenMarket: (marketId: string) => void;
  onOpenAction: (action: ConsumerAction) => void;
  onOpenProfile?: (actorId: string) => void;
  noteEditor?: (action: ConsumerAction) => ReactNode;
  marketLabel?: (marketId: string) => string;
  marketMedia?: Record<string, SocialMarketMedia | undefined>;
  renderAvatar?: SocialAvatarRenderer;
  renderSubjectImage?: SocialSubjectRenderer;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const actions = publicActions(profile.actions)
    .filter(action => action.source.mode === profile.source.mode)
    .sort((a, b) => b.atMs - a.atMs || a.id.localeCompare(b.id));
  const groups = new Map<string, ConsumerAction[]>();
  for (const action of actions) {
    const key = day(action.atMs);
    groups.set(key, [...(groups.get(key) ?? []), action]);
  }
  const naCount = actions.filter(action => action.kind === 'CALL_CLOSE' && action.returnFraction === null).length;
  const actorName = profile.actorLabel || shortActor(profile.actorId);
  return <section className="au-social" aria-label={`${actorName} public profile`}>
    <header className="au-social-heading au-social-profile-heading">
      <div className="au-social-profile-identity"><ImageOrFallback url={profile.avatarUrl} alt={profile.avatarAlt || `${actorName} avatar`} label={actorName} actorId={profile.actorId} kind="avatar" renderAvatar={renderAvatar} /><div><span className="au-social-kicker">PUBLIC PROFILE</span><h2>{actorName}</h2><small>{shortActor(profile.actorId)}</small></div></div>
      <span className="au-social-source">{profile.source.mode === 'DEMO' ? 'Example' : 'Devnet'} · {profile.source.label}</span>
    </header>
    <p className="au-social-explain">{profile.source.mode === 'DEMO' ? 'Fictional sample activity. No real wallet, transaction, or proof is implied.' : 'Public Devnet chips only. Notes can be added later or edited and are not covered by SAS proof.'}</p>
    <dl className="au-social-stats"><div><dt>Valid closed average</dt><dd>{percent(profile.meanReturnFraction)}</dd></div><div><dt>Valid closed chips</dt><dd>{profile.closedCallCount}</dd></div><div><dt>N/A closes</dt><dd>{naCount}</dd></div><div><dt>Active chips</dt><dd>{profile.openCallCount}</dd></div></dl>
    <div className="au-social-section-title"><h3>Activity</h3><span>{actions.length} {actions.length === 1 ? 'event' : 'events'} · newest first</span></div>
    {actions.length === 0 ? <p className="au-social-empty">No public chip activity yet.</p> :
      <div className="au-social-days">{[...groups].map(([groupDay, dayActions]) => <section key={groupDay} className="au-social-day" aria-label={groupDay}>
        <h4>{groupDay}</h4>
        <ol className="au-social-actions">{dayActions.map(action => {
          const metadata = marketMedia?.[action.marketId];
          const title = metadata?.title || marketLabel?.(action.marketId) || action.marketId;
          const expanded = expandedId === action.id;
          return <li key={action.id}>
            <article className="au-social-activity">
              <div className="au-social-activity-top">
                <ImageOrFallback url={action.actorAvatarUrl || profile.avatarUrl} alt="" label={actorName} actorId={action.actorId} kind="avatar" renderAvatar={renderAvatar} />
                <div className="au-social-activity-copy"><strong>{action.actorLabel || actorName}</strong><span>{actionVerb(action)}</span><time dateTime={new Date(action.atMs).toISOString()}>{time(action.atMs)}</time></div>
                <ActionResult action={action} />
              </div>
              <button type="button" className="au-social-subject" onClick={() => onOpenMarket(action.marketId)} aria-label={`Open ${title} chart`}>
                <ImageOrFallback url={metadata?.thumbnailUrl} alt={metadata?.imageAlt || `${title} artwork`} label={title} kind="subject" renderSubjectImage={renderSubjectImage} />
                <span><strong>{title}</strong><small>{metadata?.subtitle || 'View subject and chart'}</small></span><span className="au-social-chevron" aria-hidden="true">↗</span>
              </button>
              {action.note && <p className="au-social-note-preview">{action.note.body}</p>}
              <div className="au-social-activity-footer">
                <button type="button" className="au-social-expand" aria-expanded={expanded} aria-controls={`au-social-detail-${action.id}`} onClick={() => setExpandedId(expanded ? null : action.id)}>{expanded ? 'Hide details ↑' : 'View details ↓'}</button>
                <button type="button" onClick={() => onOpenAction(action)}>See on chart ↗</button>
              </div>
              {expanded && <div id={`au-social-detail-${action.id}`} className="au-social-detail">
                <p>{actionDetailMessage(action)}</p>
                <p>Action time: <time dateTime={new Date(action.atMs).toISOString()}>{date(action.atMs)}</time></p>
                {action.note && <SocialNote note={action.note} />}
                {noteEditor?.(action)}
                <div className="au-social-links">
                  <button type="button" onClick={() => onOpenAction(action)}>See chip on chart ↗</button>
                  {action.recordId && action.source.mode === 'LIVE' && <a href={`/records/${encodeURIComponent(action.recordId)}`}>Record and proof ↗</a>}
                  {onOpenProfile && <button type="button" onClick={() => onOpenProfile(action.actorId)}>Wallet profile ↗</button>}
                </div>
              </div>}
            </article>
          </li>;
        })}</ol>
      </section>)}</div>}
  </section>;
}

export function SocialNote({ note, showHistory }: { note: ConsumerNote; showHistory?: () => void }) {
  return <aside className="au-social-note" aria-label="Chip note"><p>{note.body}</p><div>
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
    <label htmlFor={`au-note-${action.id}`}>{current ? 'Edit your chip note' : 'Add a chip note'}</label>
    <textarea id={`au-note-${action.id}`} value={draft} onChange={event => setDraft(event.target.value)} maxLength={560} rows={3} placeholder="What informed your chip?" />
    <div className="au-social-editor-footer"><small>{count}/280 characters · Server time · Not covered by SAS proof</small><button type="submit" disabled={saving || count < 1 || count > 280 || !draft.trim()}>{saving ? 'Saving…' : 'Save note'}</button></div>
    {error && <p role="alert">{error}</p>}
  </form>;
}
