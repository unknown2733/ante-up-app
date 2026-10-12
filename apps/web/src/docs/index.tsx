import { Fragment, type ReactNode } from 'react';
import './docs.css';

import start from '../../../../docs/product/start.md?raw';
import walletFaucet from '../../../../docs/product/wallet-faucet.md?raw';
import chips from '../../../../docs/product/chips.md?raw';
import marketsTrading from '../../../../docs/product/markets-trading.md?raw';
import pro from '../../../../docs/product/pro.md?raw';
import liquidity from '../../../../docs/product/liquidity.md?raw';
import dataPricing from '../../../../docs/product/data-pricing.md?raw';
import recordsProofs from '../../../../docs/product/records-proofs.md?raw';
import devnetScope from '../../../../docs/product/devnet-scope.md?raw';
import faq from '../../../../docs/product/faq.md?raw';

type Article = { slug: string; title: string; group: string; summary: string; markdown: string };

const articles: Article[] = [
  { slug: 'start', title: 'Getting started', group: 'Start here', summary: 'Explore, place a chip, and find your record.', markdown: start },
  { slug: 'wallet-faucet', title: 'Wallet and faucet', group: 'Start here', summary: 'Connect on Devnet and tell SOL from test tUSD.', markdown: walletFaucet },
  { slug: 'chips', title: 'Chips', group: 'Participate', summary: 'Place, follow, and take back a no-money chip.', markdown: chips },
  { slug: 'markets-trading', title: 'Markets and trading', group: 'Participate', summary: 'Read source labels, phases, and Buy/Sell actions.', markdown: marketsTrading },
  { slug: 'pro', title: 'Pro', group: 'Trade', summary: 'Test-asset long and short positions.', markdown: pro },
  { slug: 'liquidity', title: 'Liquidity', group: 'Trade', summary: 'Vault deposits, withdrawals, and limits.', markdown: liquidity },
  { slug: 'data-pricing', title: 'Data and pricing', group: 'Understand', summary: 'Attention observations, references, and quotes.', markdown: dataPricing },
  { slug: 'records-proofs', title: 'Records and proofs', group: 'Understand', summary: 'Finalized actions, evidence, and attestations.', markdown: recordsProofs },
  { slug: 'devnet-scope', title: 'Devnet scope', group: 'Reference', summary: 'What is experimental and what may be unavailable.', markdown: devnetScope },
  { slug: 'faq', title: 'FAQ', group: 'Reference', summary: 'Short answers to common questions.', markdown: faq },
];

const slugId = (value: string) => value.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
const allowedHref = (href: string) => /^https:\/\/[^\s]+$/i.test(href) || /^\/(?:docs|markets|me|faucet|leaderboard|u|records|proofs)(?:\/[^\s]*)?$/.test(href);

/** A deliberately small Markdown subset. React escapes every text node; raw HTML is never interpreted. */
function inline(source: string): ReactNode[] {
  const result: ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > cursor) result.push(source.slice(cursor, at));
    if (match[1] !== undefined) {
      const href = match[2].trim();
      result.push(allowedHref(href) ? <a key={at} href={href} rel={href.startsWith('https:') ? 'noopener noreferrer' : undefined}>{match[1]}</a> : match[1]);
    } else if (match[3] !== undefined) result.push(<strong key={at}>{match[3]}</strong>);
    else result.push(<code key={at}>{match[4]}</code>);
    cursor = at + match[0].length;
  }
  if (cursor < source.length) result.push(source.slice(cursor));
  return result;
}

function parse(markdown: string): { title: string; sections: { id: string; title: string }[]; body: ReactNode[] } {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const body: ReactNode[] = [];
  const sections: { id: string; title: string }[] = [];
  let title = '';
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index++; continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const label = heading[2];
      const id = slugId(label);
      if (heading[1].length === 1 && !title) title = label;
      else if (heading[1].length === 2) { sections.push({ id, title: label }); body.push(<h2 id={id} key={`h-${index}`}>{inline(label)}</h2>); }
      else body.push(<h3 id={id} key={`h-${index}`}>{inline(label)}</h3>);
      index++; continue;
    }
    const ordered = /^\d+\.\s+/.test(line);
    const bullet = /^[-*]\s+/.test(line);
    if (ordered || bullet) {
      const items: ReactNode[] = [];
      const start = index;
      while (index < lines.length) {
        const current = lines[index].trim();
        const match = ordered ? /^\d+\.\s+(.+)$/.exec(current) : /^[-*]\s+(.+)$/.exec(current);
        if (!match) break;
        items.push(<li key={index}>{inline(match[1])}</li>);
        index++;
      }
      body.push(ordered ? <ol key={`list-${start}`}>{items}</ol> : <ul key={`list-${start}`}>{items}</ul>);
      continue;
    }
    const parts: string[] = [line];
    const start = index++;
    while (index < lines.length && lines[index].trim() && !/^#{1,3}\s+|^[-*]\s+|^\d+\.\s+/.test(lines[index].trim())) parts.push(lines[index++].trim());
    body.push(<p key={`p-${start}`}>{inline(parts.join(' '))}</p>);
  }
  return { title, sections, body };
}

const urlFor = (article: Article) => `/docs/${article.slug}`;

export function DocsPage({ slug }: { slug?: string }) {
  const active = articles.find(article => article.slug === slug);
  const parsed = active ? parse(active.markdown) : null;
  const groupNames = [...new Set(articles.map(article => article.group))];

  return <section className="au-docs" id="docs-top" aria-label="Ante Up documentation">
    <div className="au-docs-shell">
      <aside className="au-docs-rail" aria-label="Documentation navigation">
        <a className="au-docs-brand" href="/docs"><img src="/brand/ante-up-logo-transparent.png" alt="Ante Up" /><span>Docs</span></a>
        {groupNames.map(group => <Fragment key={group}><div className="au-docs-group">{group}</div><nav aria-label={`${group} docs`}>{articles.filter(article => article.group === group).map(article => <a key={article.slug} href={urlFor(article)} aria-current={active?.slug === article.slug ? 'page' : undefined}>{article.title}</a>)}</nav></Fragment>)}
      </aside>
      <div className="au-docs-main">
        <div className="au-docs-breadcrumb"><a href="/markets">Explore</a><span aria-hidden="true">/</span><a href="/docs">Docs</a>{active && <><span aria-hidden="true">/</span><span>{active.title}</span></>}</div>
        {!slug ? <><div className="au-docs-hero"><span className="au-docs-kicker">THE GUIDE</span><h1>Know what your chip means.</h1><p>Explore attention, understand each action, and check what the record can prove.</p><a href="/docs/start" className="au-docs-cta">Get started <span aria-hidden="true">↗</span></a></div><div className="au-docs-card-grid">{articles.map(article => <a key={article.slug} href={urlFor(article)} className="au-docs-card"><span>{article.group}</span><h2>{article.title}</h2><p>{article.summary}</p><b aria-hidden="true">↗</b></a>)}</div></> : !active || !parsed ? <div className="au-docs-not-found"><h1>Page not found.</h1><p>This Docs link may have changed.</p><a href="/docs">Browse all Docs →</a></div> : <div className="au-docs-article-layout"><article className="au-docs-article"><span className="au-docs-kicker">{active.group}</span><h1>{parsed.title}</h1><p className="au-docs-deck">{active.summary}</p>{parsed.body}<div className="au-docs-end"><span>Ready to keep exploring?</span><a href="/docs">All Docs →</a></div></article><nav className="au-docs-toc" aria-label="On this page"><strong>On this page</strong>{parsed.sections.map(section => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}<a href="#docs-top" className="au-docs-backtop">Back to top ↑</a></nav></div>}
      </div>
    </div>
  </section>;
}

export default DocsPage;
