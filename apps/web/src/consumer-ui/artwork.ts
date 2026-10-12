/** Returns the current cover unless the current URL itself failed to load. */
export function artworkSource(url: string | null | undefined, failedUrl: string | null): string | null {
  return url && url !== failedUrl ? url : null;
}
