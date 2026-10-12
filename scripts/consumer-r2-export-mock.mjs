/** Local browser fixture exports. The Live row is a QA shell, never deployed evidence. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleR2Mock } from './consumer-r2-serve.mjs';

const qaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const index = args.indexOf('--integration-root');
if (index < 0 || !args[index + 1]) throw new Error('Usage: node scripts/consumer-r2-export-mock.mjs --integration-root PATH');
const sourceRoot = path.resolve(args[index + 1]);
const { demoConsumerReadApi } = await import(pathToFileURL(path.join(sourceRoot, 'apps/web/src/demo/consumerDemo.ts')).href);
const { demoActors } = await import(pathToFileURL(path.join(sourceRoot, 'contracts/fixtures/consumer/catalog.ts')).href);
const request = async route => (await (await handleR2Mock(new Request('http://qa.local/v1/consumer' + route))).json()).data;
const samples = await demoConsumerReadApi.listMarkets();
const live = await request('/markets');
const markets = [...samples, ...live];
const histories = await Promise.all(samples.flatMap(market =>
  ['1D', '1W', '1M', 'ALL'].map(period => demoConsumerReadApi.getHistory(market.id, period))));
for (const period of ['1D', '1W', '1M', 'ALL']) histories.push(await request(`/markets/${encodeURIComponent(live[0].id)}/history?period=${period}`));
const profiles = await Promise.all(demoActors.map(actor => demoConsumerReadApi.getProfile(actor.id)));
profiles.push(await request('/profiles/qa-wallet'));
const leaderboards = await Promise.all(['7D', 'ALL'].map(period => demoConsumerReadApi.getLeaderboard(period)));
for (const period of ['7D', 'ALL']) leaderboards.push(await request(`/leaderboard?period=${period}`));
const output = path.join(qaRoot, '.runtime/consumer-r2-qa');
await mkdir(output, { recursive: true });
const catalogFile = path.join(output, 'integrated-mock-catalog.json');
const modelFile = path.join(output, 'integrated-mock-read-model.json');
await writeFile(catalogFile, JSON.stringify(markets, null, 2));
await writeFile(modelFile, JSON.stringify({ markets, histories, profiles, leaderboards }, null, 2));
console.log(JSON.stringify({ catalogFile, modelFile, sampleCount: samples.length, liveMockCount: live.length,
  warning: 'The Live market is a local QA shell with zero observations/actions; do not cite this as deployed Devnet provenance.' }, null, 2));
