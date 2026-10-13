import type { FreeRecord, Mode, ProofStatus } from '../../../../contracts/types';
import { summaryProof, summaryResult } from './recordSummaryModel';
import './recordSummary.css';

function Stamp({ seconds }: { seconds: number }) {
  const iso = new Date(seconds * 1000).toISOString();
  return <time dateTime={iso}><strong>{iso.slice(11, 16)} <small>UTC</small></strong><span>{new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(seconds * 1000)}</span></time>;
}

export function RecordSummary({ record, title, proof, mode, loading = false, unavailable = false }: { record: FreeRecord; title: string; proof: ProofStatus | null; mode: Mode | null; loading?: boolean; unavailable?: boolean }) {
  const closed = record.status !== 'OPEN';
  const final = record.finality === 'finalized';
  const result = summaryResult(record);
  return <section className="au-record-summary" aria-label="Chip record summary">
    <header><div><span className="eyebrow blue-text">CHIP RECORD</span><h1>{title}<span className="title-dot">.</span></h1></div><span className="au-record-state">{!final ? 'Confirming' : closed ? 'Closed · finalized' : 'Active'}</span></header>
    <div className="au-record-result"><span>Attention change since placement</span><strong className={record.result?.kind === 'return' && /^-\d+$/.test(record.result.numerator) ? 'au-record-negative' : ''}>{result}</strong><p>{!final ? 'Awaiting final chain confirmation' : closed ? 'Fixed when taken back · not a cash return' : 'Take back your chip to finalize the result'}</p></div>
    <div className="au-record-times"><div><span>Placed chip</span><Stamp seconds={record.entry.executedAt} /></div><div><span>Took back chip</span>{record.exit ? <Stamp seconds={record.exit.executedAt} /> : <strong>Still active</strong>}</div></div>
    <footer><span role="status">{summaryProof(record, proof, mode, loading, unavailable)}</span><a href="#record-proof">Verify record ↓</a></footer>
  </section>;
}
