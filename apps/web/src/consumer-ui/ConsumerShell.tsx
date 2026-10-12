import type { ReactNode } from 'react';
import type { ConsumerMode } from '../../../../contracts/consumer';
import { consumerCopy } from './copy';

export type ConsumerRoute = 'discover' | 'leaderboard' | 'activity' | 'funds';

export interface ConsumerShellProps {
  mode: ConsumerMode;
  route: ConsumerRoute;
  onNavigate: (route: ConsumerRoute) => void;
  onModeChange?: (mode: ConsumerMode) => void;
  walletSlot?: ReactNode;
  children: ReactNode;
}

const routes: ConsumerRoute[] = ['discover', 'leaderboard', 'activity', 'funds'];

export function BrandLockup() {
  return <img className="au-brand" src="/brand/ante-up-logo-transparent.png" alt="Ante Up" width="150" height="50" />;
}

export function ModeBadge({ mode }: { mode: ConsumerMode }) {
  return <span className={`au-mode-badge au-mode-${mode.toLowerCase()}`}><span aria-hidden="true" />{consumerCopy.modes[mode]}</span>;
}

export function ConsumerShell({ mode, route, onNavigate, onModeChange, walletSlot, children }: ConsumerShellProps) {
  return <div className="au-app">
    <div className="au-network-strip"><div className="au-shell-width"><ModeBadge mode={mode} /><span className="au-network-description">{mode === 'DEMO' ? 'Simulated markets and activity. No wallet trades or proof.' : 'Real Devnet records. Trades require a wallet signature.'}</span>{onModeChange && <div className="au-mobile-mode-switch"><button type="button" aria-pressed={mode === 'LIVE'} onClick={() => onModeChange('LIVE')}>Live</button><button type="button" aria-pressed={mode === 'DEMO'} onClick={() => onModeChange('DEMO')}>Demo</button></div>}</div></div>
    <header className="au-header"><div className="au-shell-width au-header-inner">
      <button type="button" className="au-brand-button" onClick={() => onNavigate('discover')} aria-label="Ante Up, discover markets"><BrandLockup /></button>
      <nav className="au-primary-nav" aria-label="Main navigation">{routes.map((item) => <button key={item} type="button" className={route === item ? 'active' : ''} aria-current={route === item ? 'page' : undefined} onClick={() => onNavigate(item)}>{consumerCopy.nav[item]}</button>)}</nav>
      <div className="au-header-actions">{onModeChange && <div className="au-mode-switch" aria-label="Market mode"><button type="button" className={mode === 'LIVE' ? 'active' : ''} aria-pressed={mode === 'LIVE'} onClick={() => onModeChange('LIVE')}>Live</button><button type="button" className={mode === 'DEMO' ? 'active' : ''} aria-pressed={mode === 'DEMO'} onClick={() => onModeChange('DEMO')}>Demo</button></div>}{walletSlot}</div>
    </div></header>
    <main className="au-main au-shell-width" id="main-content">{children}</main>
    <footer className="au-footer"><div className="au-shell-width"><span>ANTE UP<span className="au-orange">.</span></span><span>{mode === 'DEMO' ? 'Demo data is simulated.' : 'Solana Devnet · Verify every quote before signing.'}</span></div></footer>
    <nav className="au-bottom-nav" aria-label="Mobile navigation">{routes.map((item) => <button key={item} type="button" className={route === item ? 'active' : ''} aria-current={route === item ? 'page' : undefined} onClick={() => onNavigate(item)}><span aria-hidden="true">{item === 'discover' ? '⌕' : item === 'leaderboard' ? '≡' : item === 'activity' ? '◷' : '◇'}</span>{consumerCopy.nav[item]}</button>)}</nav>
  </div>;
}
