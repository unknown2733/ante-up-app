import type { FreeRecord, Mode, ProofStatus } from '../../../../contracts/types';
import { proofIsVerified } from './proofLinks.ts';

export interface ResultCardData {
  title: string; result: string; negative: boolean; wallet: string; recordId: string;
  placed: string; closed: string; proof: string; network: string; url: string | null; captured: string;
}
export function formatResult(record: FreeRecord): string {
  if (record.status !== 'CLOSED_RESULT' || record.result?.kind !== 'return') return 'N/A';
  try {
    const n = BigInt(record.result.numerator), d = BigInt(record.result.denominator);
    if (d <= 0n) return 'N/A';
    const abs = n < 0n ? -n : n;
    const hundredths = (abs * 10000n + d / 2n) / d;
    return `${hundredths === 0n ? '' : n < 0n ? '−' : '+'}${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}%`;
  } catch { return 'N/A'; }
}
const utc = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
export function createResultCard(record: FreeRecord, title: string, mode: Mode | null, proof: ProofStatus | null, proofUnavailable = false, now = Date.now()): ResultCardData | null {
  if (record.status === 'OPEN' || record.finality !== 'finalized' || !record.exit) return null;
  const matched = !proofUnavailable && proof?.recordId === record.id && proof.id === record.proofId ? proof : null;
  const state = matched?.state;
  const proofLabel = mode !== 'fixture' && proofIsVerified(matched) ? 'SAS issued' : state === 'INVALID' ? 'Proof invalid' : state === 'REPLACED' ? 'Proof replaced' : proofUnavailable ? 'Proof status unavailable' : 'Proof pending';
  return { title, result: formatResult(record), negative: record.result?.kind === 'return' && /^-\d+$/.test(record.result.numerator), wallet: record.wallet, recordId: record.id,
    placed: utc(record.entry.executedAt), closed: utc(record.exit.executedAt), proof: proofLabel,
    network: mode === 'devnet' ? 'SOLANA DEVNET' : mode === 'localnet' ? 'LOCALNET TEST' : mode === 'fixture' ? 'SAMPLE RECORD' : 'NETWORK UNAVAILABLE',
    url: mode === 'devnet' ? `https://ante-up.fun/records/${encodeURIComponent(record.id)}` : null,
    captured: utc(Math.floor(now / 1000)) };
}
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!));
const short = (value: string, length: number) => Array.from(value).length > length ? Array.from(value).slice(0, length - 1).join('') + '…' : value;

/** Standalone SVG uses escaped public record fields and no remote media or scripts. */
export function resultCardSvg(data: ResultCardData, logoDataUrl?: string): string {
  const text = (x: number, y: number, value: string, size = 26, fill = '#241c18', weight = 400) => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}">${escape(value)}</text>`;
  const resultSize = Math.min(146, Math.floor(890 / Math.max(data.result.length, 1) * 1.55));
  const logo = logoDataUrl?.startsWith('data:image/png;base64,') ? `<image x="64" y="50" width="82" height="82" href="${escape(logoDataUrl)}"/>` : '';
  const title = Array.from(data.title);
  const titleLines = title.length > 28 ? [title.slice(0, 28).join(''), short(title.slice(28).join(''), 28)] : [data.title];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080" role="img" aria-label="Chip result card">
    <rect width="1080" height="1080" fill="#f5f0e6"/>
    <rect x="0" width="1080" height="12" fill="#241c18"/>
    <rect x="0" y="12" width="16" height="1068" fill="#bc4b2c"/>
    <g font-family="Arial, Helvetica, sans-serif">
      ${logo}
      ${text(logo ? 166 : 64, 107, 'ANTE UP', 43, '#241c18', 800)}
      ${text(64, 184, 'CALL IT. ANTE UP. PROVE IT.', 19, '#685d55', 700)}
      ${text(755, 89, data.network, 18, '#8b3f2a', 700)}
      <path d="M64 222H1016" stroke="#b5aa9b"/>
      ${text(64, 275, 'CHIP RESULT  /  UP', 20, '#8b3f2a', 700)}
      <g font-family="Georgia, Times New Roman, serif">
        ${titleLines.map((line, i) => text(64, 346 + i * 58, line, 48, '#241c18')).join('')}
        ${text(64, 564, data.result, resultSize, data.negative ? '#a83d35' : '#241c18')}
      </g>
      ${text(68, 614, 'Attention change · not a cash return', 27, '#685d55')}
      <path d="M80 688H994" stroke="#b5aa9b" stroke-width="3"/>
      <circle cx="80" cy="688" r="11" fill="#bc4b2c"/>
      <circle cx="994" cy="688" r="11" fill="#241c18"/>
      ${text(64, 733, 'PLACED CHIP', 18, '#685d55', 700)}
      ${text(594, 733, 'TOOK BACK CHIP', 18, '#685d55', 700)}
      ${text(64, 772, data.placed, 25)}
      ${text(594, 772, data.closed, 25)}
      ${text(64, 830, `${data.wallet.slice(0, 8)}…${data.wallet.slice(-6)}`, 24, '#241c18', 700)}
      ${text(594, 830, data.proof, 24, '#8b3f2a', 700)}
      <path d="M64 863H1016" stroke="#b5aa9b"/>
      ${text(64, 903, data.url ? 'VIEW THE RECORD  →  ante-up.fun/records/' : 'LOCAL PREVIEW · NO PUBLIC RECORD LINK', 20, '#241c18', 700)}
      ${text(64, 940, short(data.recordId, 72), 20, '#685d55')}
      ${text(64, 1000, `Card captured ${data.captured}`, 18, '#685d55')}
      ${text(64, 1032, 'Snapshot only. Open the record for current evidence and proof status.', 18, '#685d55')}
    </g>
  </svg>`;
}

export async function resultCardPng(svg: string): Promise<Blob> {
  const source = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Could not render this card. Please retry.')); image.src = source; });
    const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1080;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image export is unavailable in this browser.');
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not save the card image.')), 'image/png'));
  } finally { URL.revokeObjectURL(source); }
}
