import { useState } from 'react';
import { exampleAvatarUrl } from './exampleAvatar.ts';

export interface SubjectImageProps { src?: string | null; alt: string; className?: string; }
export interface WalletAvatarProps { address: string; src?: string | null; className?: string; }

/** Only network HTTPS and same-origin paths may be supplied by a subject feed. */
export function safeMediaSrc(src?: string | null): string | null {
  if (!src) return null;
  if (/^https:\/\/[^\s]+$/i.test(src)) return src;
  if (/^\/(?!\/)[^\s]*$/.test(src)) return src;
  return null;
}

export function SubjectImage({ src, alt, className }: SubjectImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const safeSrc = safeMediaSrc(src);
  if (!safeSrc || safeSrc === failedSrc) {
    return <span className={className} role="img" aria-label={alt} style={{ display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg,#183247,#3c6570)', color: '#c9e7e7' }}>
      <svg aria-hidden="true" viewBox="0 0 64 64" width="42%" height="42%" fill="none"><rect x="8" y="12" width="48" height="40" rx="7" stroke="currentColor" strokeWidth="3"/><circle cx="23" cy="26" r="5" fill="currentColor"/><path d="m11 47 15-14 10 8 9-11 9 12" stroke="currentColor" strokeWidth="3" strokeLinejoin="round"/></svg>
    </span>;
  }
  return <img className={className} src={safeSrc} alt={alt} loading="lazy" decoding="async" onError={() => setFailedSrc(safeSrc)} />;
}

export function WalletAvatar({ address, src, className }: WalletAvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const externalSrc = safeMediaSrc(src);
  const activeSrc = externalSrc && externalSrc !== failedSrc ? externalSrc : exampleAvatarUrl(address);
  return <img className={className} src={activeSrc} alt={`Avatar for ${address}`} loading="lazy" decoding="async" onError={() => setFailedSrc(activeSrc)} />;
}
