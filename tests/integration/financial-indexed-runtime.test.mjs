import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer as createVite} from '../../apps/web/node_modules/vite/dist/node/index.js';
import * as chain from '../../clients/chain/dist/index.js';
import {FinalizedFinancialAccounts,FirstSliceFinancialReader,TOKEN_PROGRAM,ASSOCIATED_TOKEN_PROGRAM} from '../../services/api/src/financial-chain.ts';
import {KitFirstSliceFinancialTransactionAdapter} from '../../services/api/src/financial-transaction.ts';
import {SqliteFinancialRegistrationStore} from '../../services/api/src/registration.ts';
import {validateFinancialIntent,validateFinancialQuote,validatePreparedFinancial} from '../../services/api/src/financial.ts';
import {pro,timeFee,UNIT,Q12} from '../../contracts/reference.mjs';

const kit=createRequire(new URL('../../clients/chain/package.json',import.meta.url))('@solana/kit');
const {address,getBase58Decoder,getAddressEncoder,getProgramDerivedAddress,getTransactionDecoder}=kit;
const randomAddress=()=>address(getBase58Decoder().decode(randomBytes(32)));

// Encoded finalized RPC fixtures, production D readers/builders and F verifier.
// This checks their contract together; it does not execute financial instructions.
test('indexed financial quotes survive real API encoding and browser verification',async()=>{
  const dir=await mkdtemp(join(process.cwd(),'.indexed-integration-'));
  let vite,registrations;
  try {
    const now=1_800_000_000,owner=randomAddress(),admin=randomAddress(),mint=randomAddress();
    const programId=chain.ANTE_UP_PROGRAM_ADDRESS,id=randomBytes(32),hash=randomBytes(32);
    const [configAddress]=await chain.findConfigPda(),[financeAddress]=await chain.findFinanceConfigPda();
    const [marketId]=await chain.findMarketPda({marketId:id});
    const [fmAddress,bump]=await chain.findFinanceMarketPda({market:marketId});
    const [keywordMint]=await chain.findKeywordMintPda({market:marketId});
    const [curveInventory]=await chain.findCurveInventoryPda({market:marketId});
    const [vaultInventory]=await chain.findVaultInventoryPda({market:marketId});
    const [paymentVault]=await chain.findPaymentVaultPda({market:marketId});
    const ata=async(o,m)=>(await getProgramDerivedAddress({programAddress:address(ASSOCIATED_TOKEN_PROGRAM),
      seeds:[getAddressEncoder().encode(o),getAddressEncoder().encode(address(TOKEN_PROGRAM)),getAddressEncoder().encode(m)]}))[0];
    const treasury=await ata(admin,mint),paymentAta=await ata(owner,mint),keywordAta=await ata(owner,keywordMint);
    const accounts=new Map();
    const put=(key,data,ownerProgramId=programId)=>accounts.set(key,{data,ownerProgramId});
    function token(key,m,o,amount){const data=Buffer.alloc(165);data.set(getAddressEncoder().encode(m),0);
      data.set(getAddressEncoder().encode(o),32);data.writeBigUInt64LE(amount,64);data[108]=1;put(key,data,TOKEN_PROGRAM);}
    function mintAccount(key,authority,supply){const data=Buffer.alloc(82);
      if(authority){data.writeUInt32LE(1,0);data.set(getAddressEncoder().encode(authority),4);}
      data.writeBigUInt64LE(supply,36);data[44]=6;data[45]=1;put(key,data,TOKEN_PROGRAM);}
    const week=(BigInt(now)-345600n)/604800n*604800n+345600n,maturity=week+604800n;
    const market={id,admin,queryHash:hash,queryVersion:1n,phase:chain.MarketPhase.Indexed,
      dataStatus:chain.DataStatus.Valid,admission:{state:chain.AdmissionState.Open,recoveryCount:0,reason:null},
      latestSequence:7n,latestHash:hash,latestDataThrough:BigInt(now-50),latestNowQ12:125n*Q12,
      latest7dQ12:100n*Q12,validityGeneration:0n};
    const fm={market:marketId,keywordMint,paymentVault,curveInventory,vaultInventory,bump,stateVersion:3n,
      curveSold:1000n*UNIT,curveReserve:1100n*UNIT,marketFees:0n,externalQ:1000n*UNIT,
      anchorPg:1200000n,anchorSg:125n*Q12,anchorDg:100n*Q12,pmax:4800000n,
      proReserved:0n,otherReserved:0n,openPositions:0,totalShares:7100n*UNIT,lockedShares:7000n*UNIT,
      lpWindowStart:BigInt(now-100),lpWindowEnd:BigInt(now+800),proReopenAt:BigInt(now+800),
      currentMaturity:0n,currentCycle:0n,lastLpMaturity:week,lpGeneration:0n};
    const refresh=()=>{put(marketId,chain.getMarketEncoder().encode(market));put(fmAddress,chain.getFinanceMarketEncoder().encode(fm));};
    const [snapshotAddress]=await chain.findSnapshotPda({market:marketId,sequence:7n});
    put(snapshotAddress,chain.getSnapshotEncoder().encode({market:marketId,sequence:7n,payloadHash:hash,evidenceHash:hash,
      queryHash:hash,queryVersion:1n,configVersion:4n,formulaVersion:Buffer.from('h3-d7-q12-v1'.padEnd(16,'\0')),
      dataThrough:BigInt(now-50),publishedAt:BigInt(now-40),activityNowQ12:125n*Q12,activity7dQ12:100n*Q12,
      dataStatus:chain.DataStatus.Valid,admission:market.admission}));
    put(configAddress,chain.getConfigEncoder().encode({admin,publisher:admin,proofAuthority:admin,
      formulaVersion:Buffer.from('h3-d7-q12-v1'.padEnd(16,'\0')),configVersion:4n}));
    put(financeAddress,chain.getFinanceConfigEncoder().encode({admin,paymentMint:mint,protocolTreasury:treasury,
      faucetAmount:1000n*UNIT,faucetCooldown:86400n,faucetTotalLimit:100000n*UNIT,faucetMinted:0n,supportedMarkets:1,supportSpent:7200n*UNIT}));
    mintAccount(mint,financeAddress,100000n*UNIT);mintAccount(keywordMint,null,2000n*UNIT);
    token(treasury,mint,admin,50000n*UNIT);token(paymentAta,mint,owner,10000n*UNIT);
    token(keywordAta,keywordMint,owner,100n*UNIT);token(paymentVault,mint,fmAddress,8300n*UNIT);
    token(vaultInventory,keywordMint,fmAddress,1000n*UNIT);
    const [holding]=await chain.findHoldingPda({market:marketId,owner});
    put(holding,chain.getLpHoldingEncoder().encode({market:marketId,owner,shares:100n*UNIT}));refresh();
    const state=new FinalizedFinancialAccounts({cluster:'localnet',programId,accounts:{async get(key){return accounts.get(key)??null}}});
    registrations=new SqliteFinancialRegistrationStore(join(dir,'registry.sqlite'));
    const reader=new FirstSliceFinancialReader(state,registrations,()=>now);
    const builder=new KitFirstSliceFinancialTransactionAdapter({state,reader,now:()=>now,
      blockhashes:{async latest(){return {blockhash:'11111111111111111111111111111111',lastValidBlockHeight:999n}}}});
    const transport={async getFinalizedAccount(key){const raw=accounts.get(key);return raw?{exists:true,address:key,
      programAddress:raw.ownerProgramId,data:raw.data,executable:false,lamports:1n,space:BigInt(raw.data.length)}:{exists:false,address:key}}};
    vite=await createVite({root:fileURLToPath(new URL('../../apps/web',import.meta.url)),
      optimizeDeps:{noDiscovery:true},server:{middlewareMode:true,hmr:false},appType:'custom'});
    const {createFinancialInstructionVerifier}=await vite.ssrLoadModule('/src/financialInstructionVerifier.ts');
    const verify=createFinancialInstructionVerifier(transport,()=>now);
    const view={id:marketId,keyword:'dubai chocolate',aliases:[],phase:'INDEXED',dataStatus:'VALID',epochPhase:'INITIAL_LP',supported:true,
      chain:{cluster:'localnet',programId,address:marketId},snapshot:{payload:{marketId,sequence:'7',dataThrough:now-50,configVersion:'4'},
        payloadHash:Buffer.from(hash).toString('hex'),finality:'finalized'},anchor:null,price:{kind:'indexed',atoms:'1200000',executable:true},capabilities:{}};
    async function check(action,extra){
      const intent=validateFinancialIntent({requestId:randomUUID(),wallet:owner,marketId,action,...extra});
      const quote=await reader.quote(intent,view,now);assert.ok(quote,`quote: ${action}`);
      validateFinancialQuote(quote,intent,view,{cluster:'localnet',programId,now});
      const result=await validatePreparedFinancial(await builder.prepare(quote),quote,builder,{cluster:'localnet',programId,now});
      await verify(getTransactionDecoder().decode(Buffer.from(result.prepared.unsignedTransaction,'base64')),result.prepared,
        {address:owner,cluster:'localnet',supportedTransactionVersions:new Set([0])});
      return quote;
    }
    await check('spotBuy',{quantityAtoms:UNIT.toString()});
    await check('spotSell',{quantityAtoms:UNIT.toString()});
    await check('depositLP',{quantityAtoms:UNIT.toString()});
    await check('withdrawLP',{quantityAtoms:UNIT.toString()});
    fm.lpWindowEnd=BigInt(now-1);fm.proReopenAt=BigInt(now-1);view.epochPhase='PRO_OPEN';refresh();
    await check('openPro',{collateralAtoms:(100n*UNIT).toString(),leverageBps:'50000',direction:'long'});
    await check('openPro',{collateralAtoms:(100n*UNIT).toString(),leverageBps:'50000',direction:'short'});
    const terms=pro(100n*UNIT,50000n,1200000n,1200000n,fm.pmax,'long');
    const opened=BigInt(now-60),fees=timeFee(terms.capital,terms.notional,maturity-opened,60n);
    const [positionId]=await chain.findPositionPda({market:marketId,owner,positionId:1n});
    const position={market:marketId,owner,id:1n,cycle:1n,direction:chain.PositionDirection.Long,collateral:100n*UNIT,
      notional:terms.notional,leverageBps:50000n,entryPrice:1200000n,maximumPayout:terms.reserve,capital:terms.capital,
      prepaidFee:fees.prepaid,openedAt:opened,maturity,state:chain.PositionState.Open,settlementPrice:0n};
    put(positionId,chain.getProPositionEncoder().encode(position));
    fm.proReserved=terms.reserve;fm.otherReserved=fees.prepaid;fm.openPositions=1;fm.currentCycle=1n;fm.currentMaturity=maturity;refresh();
    await check('closePro',{positionId});
    const [claimId]=await chain.findClaimPda({position:positionId});
    put(claimId,chain.getProClaimEncoder().encode({market:marketId,owner,position:positionId,payout:100n*UNIT,refund:fees.refund,paid:false}));
    put(positionId,chain.getProPositionEncoder().encode({...position,state:chain.PositionState.Settled}));
    fm.proReserved=0n;fm.otherReserved=100n*UNIT+fees.refund;fm.openPositions=0;refresh();
    // A fixed unpaid claim must remain available even when observations disappear.
    view.snapshot=null;view.dataStatus='OUTAGE';market.dataStatus=chain.DataStatus.Outage;refresh();
    const claim=await check('claim',{claimId});assert.equal(claim.snapshot,null);
  } finally {if(vite)await vite.close();if(registrations)registrations.close();await rm(dir,{recursive:true,force:true});}
});
