import { readFile } from 'node:fs/promises';
import { validatePaidXRegistry } from '../../../scripts/paid-x-approvals.mjs';

/** The operator's paid-X decision also declares the candidate handoff path. */
export async function approvedCandidatePaths(registryPath: string | undefined): Promise<string[]> {
  if (!registryPath) return [];
  const registry=validatePaidXRegistry(JSON.parse(await readFile(registryPath,'utf8')));
  return registry.markets.flatMap((market: {candidatePath?:string}) =>
    market.candidatePath ? [market.candidatePath] : []);
}
