import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { FreeRecord } from '../../../../contracts/types';
import { marketDisplayTitle } from './catalog';

/** Presentation only. A finalized record supplies the time; local wall-clock time never does. */
export function ChipCompletion({ title, record, children }: { title: string; record: FreeRecord | null; children: ReactNode }) {
  const container = useRef<HTMLElement>(null);
  useEffect(() => { container.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, []);
  const time = (seconds: number) => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC', hour12: false }).format(seconds * 1000) + ' UTC';
  return <section ref={container} className="au-chip-completion" aria-label="Finalized chip summary"><div className="au-chip-completion-heading"><h3>{marketDisplayTitle(title)}</h3><strong>1 chip · Finalized</strong></div><p className="au-chip-participation-time">{record ? <>Placed <time dateTime={new Date(record.entry.executedAt * 1000).toISOString()}>{time(record.entry.executedAt)}</time>{record.exit && <><br />Returned <time dateTime={new Date(record.exit.executedAt * 1000).toISOString()}>{time(record.exit.executedAt)}</time></>}</> : 'Participation time syncing from your record…'}</p>{children}</section>;
}
