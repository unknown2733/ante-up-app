import type { ReactNode } from 'react';

export type ConsumerRoute = 'discover' | 'leaderboard' | 'activity' | 'funds' | 'docs';
export interface ConsumerShellProps {
  route: ConsumerRoute;
  onNavigate: (route: ConsumerRoute) => void;
  walletSlot?: ReactNode;
  children: ReactNode;
}

const routes: Array<{ id: ConsumerRoute; label: string; glyph: string }> = [
  { id: 'discover', label: 'Explore', glyph: '⌕' },
  { id: 'leaderboard', label: 'Leaderboard', glyph: '≡' },
  { id: 'activity', label: 'My activity', glyph: '◷' },
  { id: 'funds', label: 'Funds', glyph: '◇' },
  { id: 'docs', label: 'Docs', glyph: '☷' },
];

export function BrandLockup() {
  return <img className="au-brand" src="/brand/ante-up-logo-transparent.png" alt="Ante Up" width="150" height="50" />;
}

export function ConsumerShell({ route, onNavigate, walletSlot, children }: ConsumerShellProps) {
  return <div className="au-app">
    <header className="au-header"><div className="au-shell-width au-header-inner">
      <button type="button" className="au-brand-button" onClick={() => onNavigate('discover')} aria-label="Ante Up, explore markets"><BrandLockup /></button>
      <nav className="au-primary-nav" aria-label="Main navigation">{routes.map(item => <button key={item.id} type="button" className={route === item.id ? 'active' : ''} aria-current={route === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>{item.label}</button>)}</nav>
      <div className="au-header-actions">{walletSlot}</div>
    </div></header>
    <main className="au-main au-shell-width" id="main-content">{children}</main>
    <footer className="au-footer"><div className="au-shell-width"><span>ANTE UP<span className="au-orange">.</span></span><span>Call it. Ante up. Prove it. · Solana Devnet</span></div></footer>
    <nav className="au-bottom-nav" aria-label="Mobile navigation">{routes.map(item => <button key={item.id} type="button" className={route === item.id ? 'active' : ''} aria-current={route === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}><span aria-hidden="true">{item.glyph}</span>{item.label}</button>)}</nav>
  </div>;
}
