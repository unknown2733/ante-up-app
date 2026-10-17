import { join, resolve } from 'node:path';

export function collectorProjectionDbPath(configDirectory, env) {
  if (env.ANTE_UP_EXTERNAL_INDEXER === 'yes') {
    if (!env.ANTE_UP_INDEX_DB) throw new Error('MISSING_ANTE_UP_INDEX_DB');
    return resolve(env.ANTE_UP_INDEX_DB);
  }
  return join(configDirectory, 'index.sqlite');
}
