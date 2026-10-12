/** Canonical live free-call identity used by charts, profiles and notes. */
export type FreeActionSide = 'open' | 'close';
const component = (value: string) => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);

export function consumerLiveNamespace(cluster: 'devnet', programId: string): string {
  if (cluster !== 'devnet' || !component(programId)) throw new Error('INVALID_CONSUMER_NAMESPACE');
  return `${cluster}:${programId}`;
}

export function consumerFreeActionId(namespace: string, recordId: string, side: FreeActionSide): string {
  const parts = namespace.split(':');
  if (parts.length !== 2 || parts[0] !== 'devnet' || !component(parts[1])) throw new Error('INVALID_CONSUMER_NAMESPACE');
  if (!component(recordId) || (side !== 'open' && side !== 'close')) throw new Error('INVALID_CONSUMER_ACTION');
  return `${namespace}:${recordId}:${side}`;
}

export function parseConsumerFreeActionId(namespace: string, actionId: string): { recordId: string; side: FreeActionSide } | null {
  if (!actionId.startsWith(namespace + ':')) return null;
  const parts = actionId.slice(namespace.length + 1).split(':');
  if (parts.length !== 2 || !component(parts[0]) || (parts[1] !== 'open' && parts[1] !== 'close')) return null;
  try {
    return consumerFreeActionId(namespace, parts[0], parts[1]) === actionId ? { recordId: parts[0], side: parts[1] } : null;
  } catch { return null; }
}
