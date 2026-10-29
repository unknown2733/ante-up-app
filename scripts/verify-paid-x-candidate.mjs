// Read-only check before an operator approves a paid X collector.
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as chain from '../clients/chain/dist/index.js';
import {buildQuery} from '../services/data/index.mjs';
import {queryHashFor} from '../services/data/live.mjs';
import {KitFinalizedAccountReader} from '../services/indexer/src/repositories.ts';
import {FinalizedFinancialAccounts} from '../services/api/src/financial-chain.ts';
import {candidatePathForDirectory,validatePaidXRegistry} from './paid-x-approvals.mjs';

const kit=createRequire(new URL('../clients/chain/package.json',import.meta.url))('@solana/kit');
const DEVNET_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const positive=name=>Number.isSafeInteger(name)&&name>0;
const safe=error=>String(error?.message??error).replace(/https?:\/\/[^\s"'<>]+/g,'[RPC_URL_REDACTED]').slice(0,180);

export function verifyCandidate({marketId,config,market,registry}) {
  validatePaidXRegistry(registry);
  const candidatePath=candidatePathForDirectory(config.directory);
  if(!kit.isAddress(marketId)||config.marketId!==marketId||
      !/^[a-f0-9]{64}$/.test(config.seedHex??'')||config.queryVersion!=='1')
    throw Error('CANDIDATE_CONFIG_INVALID');
  const estimate=config.estimatedCostMicros,initial=config.initialEstimatedCostMicros;
  if(!positive(estimate)||!positive(initial)||initial<estimate||
      !positive(config.initialLimitMicros)||config.initialLimitMicros<initial||
      !positive(config.dailyLimitMicros)||config.dailyLimitMicros<estimate||
      !positive(config.totalLimitMicros)||config.totalLimitMicros<config.initialLimitMicros)
    throw Error('CANDIDATE_BUDGET_INVALID');
  const seedHex=Buffer.from(market.id).toString('hex');
  const queryHash=queryHashFor(buildQuery(config.expressions));
  const onchainHash=Buffer.from(market.queryHash).toString('hex');
  const onchainVersion=market.queryVersion.toString();
  if(config.seedHex!==seedHex||queryHash!==onchainHash||
      config.queryVersion!==onchainVersion)
    throw Error('CANDIDATE_ONCHAIN_QUERY_MISMATCH');
  const current=registry.markets.find(item=>item.marketId===marketId);
  if(current&&(current.seedHex!==seedHex||current.queryHash!==onchainHash||
      current.queryVersion!==onchainVersion))throw Error('CANDIDATE_APPROVAL_MISMATCH');
  if(!current&&registry.markets.length>=registry.maxMarkets)throw Error('PAID_X_APPROVAL_LIMIT');
  return {state:current?'ALREADY_APPROVED':'READY_FOR_OPERATOR_REVIEW',marketId,
    approvedCount:registry.markets.length,maxMarkets:registry.maxMarkets,
    queryHash:onchainHash,queryVersion:onchainVersion,candidatePath,readOnly:true,
    note:'This check does not approve spending, start collection, publish data, or graduate a market.'};
}

async function main() {
  const [marketId,configPath]=process.argv.slice(2);
  const rpcFile=process.env.ANTE_UP_RPC_URL_FILE;
  const registryPath=process.env.ANTE_UP_APPROVED_X_MARKETS_PATH;
  if(process.argv.length!==4||!isAbsolute(configPath??'')||
      !isAbsolute(rpcFile??'')||!isAbsolute(registryPath??''))
    throw Error('CANDIDATE_ARGS_INVALID');
  const endpoint=(await readFile(rpcFile,'utf8')).trim();
  if(await kit.createSolanaRpc(endpoint).getGenesisHash().send()!==DEVNET_GENESIS)
    throw Error('DEVNET_GENESIS_MISMATCH');
  const state=new FinalizedFinancialAccounts({cluster:'devnet',
    programId:String(chain.ANTE_UP_PROGRAM_ADDRESS),
    accounts:new KitFinalizedAccountReader(endpoint)});
  const [config,registry,market]=await Promise.all([
    readFile(configPath,'utf8').then(JSON.parse),
    readFile(registryPath,'utf8').then(JSON.parse),state.market(marketId)]);
  console.log(JSON.stringify(verifyCandidate({marketId,config,market,registry})));
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{console.error(safe(error));process.exitCode=1;});
