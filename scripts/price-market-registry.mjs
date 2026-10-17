import { readFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

/** Include finalized user registrations without granting pending markets a price history. */
export async function loadPriceMarketRegistry(registryPath, registrationDbPath) {
  if ((await stat(registryPath)).size > 262_144) throw new Error('PRICE_ALLOWLIST_TOO_LARGE');
  const operatorMarkets = JSON.parse(await readFile(registryPath, 'utf8'));
  if (!Array.isArray(operatorMarkets)) throw new Error('MARKET_ALLOWLIST_INVALID');
  const db = new DatabaseSync(registrationDbPath, { readOnly: true });
  let registrations;
  try {
    registrations = db.prepare(`SELECT market_address, seed_hex, keyword, aliases_json
      FROM financial_registrations WHERE state='FINALIZED'`).all();
  } finally { db.close(); }
  const merged = new Map(registrations.map(row => [row.market_address, {
    address: row.market_address, seedHex: row.seed_hex,
    keyword: row.keyword, aliases: JSON.parse(row.aliases_json),
  }]));
  // The operator registry keeps its display/provenance fields for known markets.
  for (const entry of operatorMarkets) merged.set(entry.address, entry);
  return [...merged.values()];
}
