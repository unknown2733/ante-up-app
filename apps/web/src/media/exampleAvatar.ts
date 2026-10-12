/** Geometric sample avatar. No person's image or account identity is used. */
export function exampleAvatarUrl(address: string): string {
  let hash = 2166136261;
  for (const character of address) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const colors = [
    ['#0d5c76', '#68e0cf'], ['#6648a8', '#d3a8ff'],
    ['#9e4b42', '#ffc39a'], ['#3d6b45', '#a8e38e'],
    ['#9a5d14', '#f4d775'], ['#315e9a', '#9bd2ff'],
    ['#8d4378', '#f3a8dc'], ['#4b6670', '#b9d9df'],
  ] as const;
  const [background, foreground] = colors[(hash >>> 0) % colors.length];
  const variant = (hash >>> 5) % 3;
  const shape = variant === 0
    ? '<circle cx="32" cy="32" r="18"/>'
    : variant === 1
      ? '<rect x="16" y="16" width="32" height="32" rx="8" transform="rotate(22 32 32)"/>'
      : '<path d="M32 12 52 48H12Z"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="${background}"/><g fill="${foreground}">${shape}</g><circle cx="47" cy="18" r="5" fill="#fff" opacity=".72"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Accept HTTPS and same-origin media references; reject executable URL schemes. */
export function safeMediaSrc(src?: string | null): string | null {
  if (!src) return null;
  if (/^https:\/\/[^\s]+$/i.test(src)) return src;
  if (/^\/(?!\/)[^\s]*$/.test(src)) return src;
  return null;
}

/** The only accepted data URI is the SVG we deterministically generated for this address. */
export function walletAvatarSrc(address: string, src?: string | null): string {
  const generated = exampleAvatarUrl(address);
  return src === generated ? generated : safeMediaSrc(src) ?? generated;
}
