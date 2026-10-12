import { useState } from 'react';
import { ActionTabs, type ActionTab } from '../consumer-ui/controls';

const details: Record<ActionTab, { title: string; description: string; requirement: string }> = {
  call: { title: 'Place a chip', description: 'Pick this subject, follow attention, and take back your chip to record the result.', requirement: 'Chip placement opens when this subject has a connected Devnet market and participation is enabled.' },
  trade: { title: 'Buy / Sell', description: 'Trade this subject’s tokens with test tUSD.', requirement: 'Trading opens when this subject has a connected token market and an executable quote.' },
  pro: { title: 'Pro', description: 'Take a long or short position with test assets.', requirement: 'Pro opens after a connected market graduates and its vault can accept positions.' },
  liquidity: { title: 'Liquidity', description: 'Supply test assets to a market vault and manage your LP shares.', requirement: 'Liquidity opens when this subject has a connected vault with deposits enabled.' },
};

/** Keep the product actions discoverable without authorizing an unregistered subject. */
export function ReferenceMarketActions({ section, onChange }: { section: ActionTab; onChange: (tab: ActionTab) => void }) {
  const [sell, setSell] = useState(false);
  const [short, setShort] = useState(false);
  const [withdraw, setWithdraw] = useState(false);
  const info = details[section];
  const options: [string, string] | null = section === 'trade' ? ['Buy', 'Sell'] : section === 'pro' ? ['Long', 'Short'] : section === 'liquidity' ? ['Deposit', 'Withdraw'] : null;
  const second = section === 'trade' ? sell : section === 'pro' ? short : withdraw;
  const select = section === 'trade' ? setSell : section === 'pro' ? setShort : setWithdraw;
  const action = options ? options[second ? 1 : 0] : 'Place chip';
  return <>
    <ActionTabs value={section} onChange={onChange} />
    <section className="detail-panel finance-panel au-reference-actions" aria-label={`${info.title} availability`}>
      <div className="au-reference-action-heading"><h2>{info.title}</h2><span className="au-market-status au-phase-preview">Not open yet</span></div>
      <p>{info.description}</p>
      {options && <div className="finance-tabs" aria-label={`${info.title} direction`}>{options.map((label, index) => <button key={label} type="button" className={second === Boolean(index) ? 'active' : ''} aria-pressed={second === Boolean(index)} onClick={() => select(Boolean(index))}>{label}</button>)}</div>}
      {section !== 'call' && <div className="finance-form">
        <label>Amount{section === 'trade' && sell ? ' (tokens)' : section === 'liquidity' && withdraw ? ' (LP shares)' : ' (tUSD)'}<input inputMode="decimal" disabled placeholder="Available when this market opens" /></label>
        {section === 'pro' && <label>Leverage<select disabled defaultValue="1"><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option></select></label>}
      </div>}
      <div className="finance-facts">
        <div><span>{section === 'call' ? 'Participation' : section === 'liquidity' ? 'Vault' : 'Execution quote'}</span><strong>{section === 'call' ? 'No money required' : 'Not available'}</strong></div>
        <div><span>Market connection</span><strong>Not connected</strong></div>
      </div>
      <p id="reference-action-reason">{info.requirement} The public count above is a source snapshot.</p>
      <button type="button" className={`button full ${section === 'call' ? 'button-chip' : 'button-blue'}`} disabled aria-describedby="reference-action-reason">{action} · Not open yet</button>
      <div className="au-reference-action-links"><a className="text-link" href="/markets">Explore markets ↗</a><a className="text-link" href="/docs/markets-trading">How markets work ↗</a></div>
    </section>
  </>;
}
