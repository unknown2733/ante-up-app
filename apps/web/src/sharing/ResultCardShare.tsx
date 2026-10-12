import { useEffect, useRef, useState } from 'react';
import type { ResultCardData } from './resultCard';
import { resultCardPng, resultCardSvg } from './resultCard';
import './resultCard.css';

let logoPromise: Promise<string | undefined> | undefined;
function logo() {
  return logoPromise ??= fetch('/brand/ante-up-app-icon-offwhite.png').then(response => { if (!response.ok) throw new Error('Logo unavailable'); return response.blob(); }).then(blob => new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob);
  })).catch(() => undefined);
}

export function ResultCardShare({ data }: { data: ResultCardData }) {
  const [open, setOpen] = useState(false), [retry, setRetry] = useState(0);
  const [image, setImage] = useState<{ blob: Blob; url: string } | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [sharing, setSharing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const key = JSON.stringify(data);
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    let active = true, url: string | undefined;
    setImage(null); setError(''); setMessage('');
    logo().then(value => resultCardPng(resultCardSvg(JSON.parse(key), value))).then(blob => {
      if (!active) return;
      url = URL.createObjectURL(blob); setImage({ blob, url });
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Could not create the card. Please retry.'); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [open, key, retry]);
  const filename = `ante-up-chip-${data.recordId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}.png`;
  const file = image ? new File([image.blob], filename, { type: 'image/png' }) : null;
  const canShare = !!file && typeof navigator !== 'undefined' && !!navigator.canShare?.({ files: [file] });
  async function share() {
    if (!file || !canShare || sharing) return;
    setSharing(true); setMessage('');
    try { await navigator.share({ files: [file], title: `${data.title} · Ante Up`, text: `Chip result: ${data.result} attention change. Not a cash return.${data.url ? `\n${data.url}` : ''}` }); }
    catch (reason) { if (!(reason instanceof DOMException && reason.name === 'AbortError')) setMessage('Sharing did not complete. Save the PNG or copy the record link instead.'); }
    finally { setSharing(false); }
  }
  async function copy() {
    if (!data.url) return;
    try { await navigator.clipboard.writeText(data.url); setMessage('Record link copied.'); }
    catch { setMessage('Select and copy the record link below.'); }
  }
  return <section className="au-result-share"><div><span className="eyebrow orange-text">TAKE YOUR RESULT WITH YOU</span><h2>Share your chip</h2><p>A result card with the subject, timing and public record.</p></div>
    <button type="button" className="button button-chip" onClick={() => setOpen(true)}>Create result card ↗</button>
    {open && <dialog ref={dialog} className="au-share-dialog" aria-labelledby="result-card-heading" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <div className="au-share-heading"><h2 id="result-card-heading">Your chip, on the record.</h2><button type="button" aria-label="Close result card" onClick={() => { dialog.current?.close(); setOpen(false); }}>×</button></div>
      {image ? <img className="au-share-preview" src={image.url} width="1080" height="1080" alt={`${data.title}: ${data.result} attention change. ${data.network}. ${data.proof}. Not a cash return.`} /> : <div className="au-share-loading" role="status">{error || 'Creating your card…'}</div>}
      {error && <button type="button" className="button" onClick={() => setRetry(value => value + 1)}>Retry image</button>}
      <div className="au-share-actions">{canShare && <button type="button" className="button button-chip" disabled={sharing} onClick={share}>{sharing ? 'Sharing…' : 'Share image'}</button>}{image && <a className="button" href={image.url} download={filename}>Save PNG</a>}{data.url && <button type="button" className="button" onClick={copy}>Copy record link</button>}</div>
      <p className="tiny muted">1080 × 1080 PNG · Public chip record · Proof status is a snapshot.</p>
      {data.url && <input className="au-share-url" aria-label="Public record link" readOnly value={data.url} onFocus={event => event.target.select()} />}
      <p className="au-share-feedback" role="status">{message}</p>
    </dialog>}
  </section>;
}
