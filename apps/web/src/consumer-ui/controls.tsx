import type { ReactNode } from 'react';
import type { ConsumerMarket, ConsumerPeriod, ConsumerSubject } from '../../../../contracts/consumer';
import { consumerCopy } from './copy';

export function SubjectGlyph({ subject }: { subject: ConsumerSubject }) {
  const glyphs: Record<ConsumerSubject, string> = { KEYWORD: '#', VIDEO: '▷', TRACK: '♪', ALBUM: '▣', ACCOUNT: '@' };
  return <span className={`au-subject-glyph au-subject-${subject.toLowerCase()}`} aria-hidden="true">{glyphs[subject]}</span>;
}

export function MarketStatus({ phase }: { phase: ConsumerMarket['phase'] }) {
  return <span className={`au-market-status au-phase-${phase.toLowerCase()}`}>{consumerCopy.phases[phase]}</span>;
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="au-empty"><strong>{title}</strong>{detail && <p>{detail}</p>}{action}</div>;
}

export function ActionButton({ children, onClick, disabled = false, secondary = false }: { children: ReactNode; onClick: () => void; disabled?: boolean; secondary?: boolean }) {
  return <button className={secondary ? 'au-button-secondary' : 'au-button-action'} type="button" onClick={onClick} disabled={disabled}>{children}</button>;
}

export function PeriodControl({ value, onChange }: { value: ConsumerPeriod; onChange: (period: ConsumerPeriod) => void }) {
  const periods: ConsumerPeriod[] = ['1D', '1W', '1M', 'ALL'];
  return <div className="au-period-control" aria-label="Chart period">{periods.map((period) => <button type="button" key={period} className={value === period ? 'active' : ''} aria-pressed={value === period} onClick={() => onChange(period)}>{period === 'ALL' ? 'All' : period}</button>)}</div>;
}

export type ActionTab = 'call' | 'trade' | 'pro' | 'liquidity';
export function ActionTabs({ value, onChange, showPro = true, showLiquidity = true }: { value: ActionTab; onChange: (value: ActionTab) => void; showPro?: boolean; showLiquidity?: boolean }) {
  const tabs: Array<[ActionTab, string]> = [['call', 'Chips'], ['trade', 'Buy / Sell'], ...(showPro ? [['pro', 'Pro'] as [ActionTab, string]] : []), ...(showLiquidity ? [['liquidity', 'Liquidity'] as [ActionTab, string]] : [])];
  return <div className="au-action-tabs" role="tablist" aria-label="Market actions">{tabs.map(([id, label]) => <button key={id} role="tab" type="button" aria-selected={value === id} className={value === id ? 'active' : ''} onClick={() => onChange(id)}>{label}</button>)}</div>;
}
