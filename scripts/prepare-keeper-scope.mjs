/** Derive a Keeper scope from finalized accounts. This script never signs or writes. */
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {ANTE_UP_PROGRAM_ADDRESS, PRO_POSITION_DISCRIMINATOR, getProPositionDecoder} from '../clients/chain/dist/index.js';
import {KitFinalizedAccountReader} from '../services/indexer/src/repositories.ts';
import {FinalizedFinancialAccounts, FirstSliceFinancialReader} from '../services/api/src/financial-chain.ts';
import {SqliteFinancialRegistrationStore} from '../services/api/src/registration.ts';
import {KitFinancialEpochChain} from '../services/api/src/keeper-chain.ts';

const requireKit=createRequire(new URL('../clients/chain/package.json',import.meta.url));
const {createSolanaRpc,isAddress}=requireKit('@solana/kit');
const DEVNET_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const hex=bytes=>Buffer.from(bytes).toString('hex');
const same=(a,b)=>Buffer.from(a).equals(Buffer.from(b));
const fail=message=>{throw new Error(message);};

async function main(){
  const [marketId,previousPath]=process.argv.slice(2);
  if(process.argv.length!==4 || !isAddress(marketId) || !previousPath || !process.env.ANTE_UP_RPC_URL_FILE)
    fail('MARKET_SCOPE_AND_RPC_FILE_REQUIRED');
  const previous=JSON.parse(await readFile(previousPath,'utf8'));
  if(previous.cluster!=='devnet' || previous.marketId!==marketId ||
    previous.programId!==String(ANTE_UP_PROGRAM_ADDRESS)) fail('KEEPER_SCOPE_IDENTITY_MISMATCH');
  const endpoint=(await readFile(process.env.ANTE_UP_RPC_URL_FILE,'utf8')).trim();
  if(!/^https?:\/\//.test(endpoint) || await createSolanaRpc(endpoint).getGenesisHash().send()!==DEVNET_GENESIS)
    fail('DEVNET_RPC_IDENTITY_MISMATCH');
  const accounts=new KitFinalizedAccountReader(endpoint);
  const state=new FinalizedFinancialAccounts({cluster:'devnet',programId:previous.programId,accounts});
  const [market,finance,config,scan]=await Promise.all([
    state.market(marketId),state.financeMarket(marketId),state.config(),state.programAccounts()]);
  if(!scan || finance.currentCycle<=0n || finance.currentMaturity<=0n)
    fail('ACTIVE_FINANCIAL_CYCLE_REQUIRED');
  const positions=[];
  for(const row of scan.accounts){
    if(!same(row.data.subarray(0,8),PRO_POSITION_DISCRIMINATOR))continue;
    const decoded=getProPositionDecoder().decode(row.data);
    if(String(decoded.market)!==marketId || decoded.cycle!==finance.currentCycle)continue;
    const position=await state.position(row.address);
    if(!position || position.cycle!==finance.currentCycle)fail('KEEPER_POSITION_INVALID');
    positions.push(position);
  }
  if(!positions.length)fail('KEEPER_CYCLE_POSITIONS_UNAVAILABLE');
  const epochStartedAt=Number(positions.reduce((min,p)=>p.openedAt<min?p.openedAt:min,positions[0].openedAt));
  const scope={cluster:'devnet',programId:previous.programId,marketId,
    epoch:finance.currentCycle.toString(),epochStartedAt,maturityAt:Number(finance.currentMaturity),
    queryHash:hex(market.queryHash),queryVersion:market.queryVersion.toString(),
    configVersion:config.configVersion.toString(),anchor:{
      graduationPriceAtoms:finance.anchorPg.toString(),graduationNowQ12:finance.anchorSg.toString(),
      graduation7dQ12:finance.anchorDg.toString(),maxPriceAtoms:finance.pmax.toString()}};
  if(epochStartedAt>=scope.maturityAt ||
    previous.queryHash!==scope.queryHash || previous.queryVersion!==scope.queryVersion ||
    previous.configVersion!==scope.configVersion ||
    JSON.stringify(previous.anchor)!==JSON.stringify(scope.anchor))
    fail('KEEPER_SCOPE_UNEXPECTED_CHAIN_CHANGE');
  const registrations=new SqliteFinancialRegistrationStore(':memory:');
  try{
    const reader=new FirstSliceFinancialReader(state,registrations);
    const transport={publisherAddress:'',keeperAddress:'',send:async()=>{throw Error('READ_ONLY');},
      signatureStatus:async()=>{throw Error('READ_ONLY');}};
    const validated=await new KitFinancialEpochChain(state,reader,transport,scope).read(scope);
    console.log(JSON.stringify({scope,finalizedSlot:scan.slot,
      cyclePositions:positions.length,openPositionCount:validated.openPositionCount,
      settlementAccepted:validated.settlement!==null}));
  }finally{registrations.close();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
