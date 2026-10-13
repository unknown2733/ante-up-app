import { randomUUID } from 'node:crypto';
import { address, getAddressEncoder, getBase58Decoder, getProgramDerivedAddress, type ReadonlyUint8Array } from '@solana/kit';
import { CONFIG_DISCRIMINATOR, FINANCE_CONFIG_DISCRIMINATOR, FINANCE_MARKET_DISCRIMINATOR, MARKET_DISCRIMINATOR,
  FAUCET_RECEIPT_DISCRIMINATOR, AdmissionState, DataStatus, MarketPhase, PositionState, PositionDirection,
  getConfigDecoder, getFinanceConfigDecoder, getFinanceMarketDecoder,
  getMarketDecoder, getFaucetReceiptDecoder, findConfigPda, findFinanceConfigPda, findFinanceMarketPda,
  findMarketPda, findReceiptPda, findKeywordMintPda, findCurveInventoryPda, findVaultInventoryPda, findPaymentVaultPda,
  PRO_POSITION_DISCRIMINATOR, PRO_CLAIM_DISCRIMINATOR, LP_HOLDING_DISCRIMINATOR, SETTLEMENT_EPOCH_DISCRIMINATOR,
  SNAPSHOT_DISCRIMINATOR, getSnapshotDecoder, findSnapshotPda,
  getProPositionDecoder, getProClaimDecoder, getLpHoldingDecoder, getSettlementEpochDecoder,
  findPositionPda, findClaimPda, findHoldingPda,
  type Config, type FinanceConfig, type FinanceMarket, type Market, type ProPosition, type ProClaim,
  type LpHolding, type SettlementEpoch, type Snapshot } from '../../../clients/chain/dist/index.js';
import { UNIT, curveGross, tradeFee, indexPrice, freeCapital, pro, timeFee } from '../../../contracts/reference.mjs';
import type { FinancialIntent, FinancialPortfolio, FinancialQuote, FinancialVault } from '../../../contracts/financial.ts';
import type { EpochPhase, MarketView } from '../../../contracts/types.ts';
import type { FinalizedAccountReader, FinalizedProgramAccountScanner } from '../../indexer/src/repositories.ts';
import type { FinancialReader } from './financial.ts';
import { deriveRegistration, SqliteFinancialRegistrationStore, type DerivedRegistration } from './registration.ts';
import { financialQuoteDeadline, type FinancialClock } from './financial-clock.ts';

export const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const equal=(a:ReadonlyUint8Array,b:ReadonlyUint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const u64=(n:bigint)=>n>=0n && n<=18_446_744_073_709_551_615n;
export interface TokenAccountView {address:string;mint:string;owner:string;amount:bigint;exists:boolean}

export async function financialEpochPhase(state:FinalizedFinancialAccounts,marketAddress:string,market:Market,fm:FinanceMarket,now:number):Promise<EpochPhase|null> {
  if (market.phase!==MarketPhase.Indexed || !Number.isSafeInteger(now)) return null;
  const time=BigInt(now);
  if (fm.currentMaturity>0n) {
    if (await state.settlement(marketAddress,fm.currentCycle) || time>=fm.currentMaturity) return 'SETTLING';
    return time>=fm.currentMaturity-1800n?'OPEN_CUTOFF':'PRO_OPEN';
  }
  if (time>=fm.lpWindowStart && time<fm.lpWindowEnd && fm.openPositions===0 && fm.lpGeneration===market.validityGeneration)
    return fm.currentCycle===0n?'INITIAL_LP':'LP_WINDOW';
  const currentMonday=(time-345_600n)/604_800n*604_800n+345_600n;
  if (time>=fm.proReopenAt && time>=fm.lpWindowEnd && fm.lpGeneration===market.validityGeneration && currentMonday<=fm.lastLpMaturity) return 'PRO_OPEN';
  return null;
}

/** Finalized account source. No balances or settlement liabilities are inferred from the API DB. */
export class FinalizedFinancialAccounts {
  readonly options:{cluster:'localnet'|'devnet';programId:string;accounts:FinalizedAccountReader & Partial<FinalizedProgramAccountScanner>};
  constructor(options:{cluster:'localnet'|'devnet';programId:string;accounts:FinalizedAccountReader & Partial<FinalizedProgramAccountScanner>}) {this.options=options;}
  private async programAccount<T>(account:string, discriminator:ReadonlyUint8Array, decode:(data:ReadonlyUint8Array)=>T):Promise<T> {
    const raw=await this.options.accounts.get(account);
    if (!raw || raw.ownerProgramId!==this.options.programId || !equal(raw.data.subarray(0,8),discriminator)) throw new Error('FINANCIAL_ACCOUNT_UNAVAILABLE');
    return decode(raw.data);
  }
  async config():Promise<Config> {
    const [pda]=await findConfigPda({programAddress:address(this.options.programId)});
    return this.programAccount(String(pda),CONFIG_DISCRIMINATOR,data=>getConfigDecoder().decode(data));
  }
  async financeConfig():Promise<FinanceConfig> {
    const [pda]=await findFinanceConfigPda({programAddress:address(this.options.programId)});
    return this.programAccount(String(pda),FINANCE_CONFIG_DISCRIMINATOR,data=>getFinanceConfigDecoder().decode(data));
  }
  async market(marketAddress:string):Promise<Market> {
    const raw=await this.programAccount(marketAddress,MARKET_DISCRIMINATOR,data=>getMarketDecoder().decode(data));
    const [pda]=await findMarketPda({marketId:raw.id},{programAddress:address(this.options.programId)});
    if (String(pda)!==marketAddress) throw new Error('FINANCIAL_MARKET_PDA_MISMATCH');
    return raw;
  }
  async financeMarket(marketAddress:string):Promise<FinanceMarket> {
    const [pda]=await findFinanceMarketPda({market:address(marketAddress)},{programAddress:address(this.options.programId)});
    const state=await this.programAccount(String(pda),FINANCE_MARKET_DISCRIMINATOR,data=>getFinanceMarketDecoder().decode(data));
    const [mint]=await findKeywordMintPda({market:address(marketAddress)},{programAddress:address(this.options.programId)});
    const [inventory]=await findCurveInventoryPda({market:address(marketAddress)},{programAddress:address(this.options.programId)});
    const [vaultInventory]=await findVaultInventoryPda({market:address(marketAddress)},{programAddress:address(this.options.programId)});
    const [vault]=await findPaymentVaultPda({market:address(marketAddress)},{programAddress:address(this.options.programId)});
    if (String(state.market)!==marketAddress || String(state.keywordMint)!==String(mint) || String(state.curveInventory)!==String(inventory) || String(state.vaultInventory)!==String(vaultInventory) || String(state.paymentVault)!==String(vault)) throw new Error('FINANCIAL_MARKET_IDENTITY_MISMATCH');
    return state;
  }
  async receipt(wallet:string) {
    const [pda]=await findReceiptPda({wallet:address(wallet)},{programAddress:address(this.options.programId)});
    const raw=await this.options.accounts.get(String(pda));
    if (!raw) return null;
    if (raw.ownerProgramId!==this.options.programId || !equal(raw.data.subarray(0,8),FAUCET_RECEIPT_DISCRIMINATOR)) throw new Error('FAUCET_RECEIPT_INVALID');
    const receipt=getFaucetReceiptDecoder().decode(raw.data);
    if (String(receipt.wallet)!==wallet) throw new Error('FAUCET_RECEIPT_OWNER_MISMATCH');
    return receipt;
  }
  async position(positionAddress:string):Promise<ProPosition|null> {
    const raw=await this.options.accounts.get(positionAddress);
    if (!raw) return null;
    if (raw.ownerProgramId!==this.options.programId || !equal(raw.data.subarray(0,8),PRO_POSITION_DISCRIMINATOR)) throw new Error('PRO_POSITION_INVALID');
    const position=getProPositionDecoder().decode(raw.data);
    const [pda]=await findPositionPda({market:position.market,owner:position.owner,positionId:position.id},{programAddress:address(this.options.programId)});
    if (String(pda)!==positionAddress) throw new Error('PRO_POSITION_PDA_MISMATCH');
    return position;
  }
  async claim(positionAddress:string):Promise<{address:string;value:ProClaim}|null> {
    const [pda]=await findClaimPda({position:address(positionAddress)},{programAddress:address(this.options.programId)});
    const result=await this.claimByAddress(String(pda));
    if (result && String(result.value.position)!==positionAddress) throw new Error('PRO_CLAIM_POSITION_MISMATCH');
    return result;
  }
  async claimByAddress(claimAddress:string):Promise<{address:string;value:ProClaim}|null> {
    const raw=await this.options.accounts.get(claimAddress);
    if (!raw) return null;
    if (raw.ownerProgramId!==this.options.programId || !equal(raw.data.subarray(0,8),PRO_CLAIM_DISCRIMINATOR)) throw new Error('PRO_CLAIM_INVALID');
    const value=getProClaimDecoder().decode(raw.data);
    const [expected]=await findClaimPda({position:value.position},{programAddress:address(this.options.programId)});
    if (String(expected)!==claimAddress) throw new Error('PRO_CLAIM_PDA_MISMATCH');
    return {address:claimAddress,value};
  }
  async holding(marketAddress:string,owner:string):Promise<{address:string;value:LpHolding}|null> {
    const [pda]=await findHoldingPda({market:address(marketAddress),owner:address(owner)},{programAddress:address(this.options.programId)});
    const holdingAddress=String(pda),raw=await this.options.accounts.get(holdingAddress);
    if (!raw) return null;
    if (raw.ownerProgramId!==this.options.programId || !equal(raw.data.subarray(0,8),LP_HOLDING_DISCRIMINATOR)) throw new Error('LP_HOLDING_INVALID');
    const value=getLpHoldingDecoder().decode(raw.data);
    if (String(value.market)!==marketAddress || String(value.owner)!==owner) throw new Error('LP_HOLDING_IDENTITY_MISMATCH');
    return {address:holdingAddress,value};
  }
  async settlementAddress(marketAddress:string,cycle:bigint):Promise<string> {
    const cycleBytes=Buffer.alloc(8);cycleBytes.writeBigUInt64LE(cycle);
    const [pda]=await getProgramDerivedAddress({programAddress:address(this.options.programId),
      seeds:[Buffer.from('settlement'),getAddressEncoder().encode(address(marketAddress)),cycleBytes]});
    return String(pda);
  }
  async settlement(marketAddress:string,cycle:bigint):Promise<{address:string;value:SettlementEpoch}|null> {
    const settlementAddress=await this.settlementAddress(marketAddress,cycle),raw=await this.options.accounts.get(settlementAddress);
    if (!raw) return null;
    if (raw.ownerProgramId!==this.options.programId || !equal(raw.data.subarray(0,8),SETTLEMENT_EPOCH_DISCRIMINATOR)) throw new Error('SETTLEMENT_ACCOUNT_INVALID');
    const value=getSettlementEpochDecoder().decode(raw.data);
    if (String(value.market)!==marketAddress || value.cycle!==cycle) throw new Error('SETTLEMENT_IDENTITY_MISMATCH');
    return {address:settlementAddress,value};
  }
  async snapshot(marketAddress:string,sequence:bigint):Promise<Snapshot|null> {
    const [pda]=await findSnapshotPda({market:address(marketAddress),sequence},{programAddress:address(this.options.programId)});
    const raw=await this.options.accounts.get(String(pda));
    if (!raw) return null;
    if (raw.ownerProgramId!==this.options.programId || !equal(raw.data.subarray(0,8),SNAPSHOT_DISCRIMINATOR))
      throw new Error('FINANCIAL_SNAPSHOT_INVALID');
    const value=getSnapshotDecoder().decode(raw.data);
    if (String(value.market)!==marketAddress || value.sequence!==sequence) throw new Error('FINANCIAL_SNAPSHOT_IDENTITY_MISMATCH');
    return value;
  }
  async programAccounts() {
    if (!this.options.accounts.scan) return null;
    const result=await this.options.accounts.scan(this.options.programId);
    if (!/^(0|[1-9][0-9]*)$/.test(result.slot) || result.accounts.some(a=>a.ownerProgramId!==this.options.programId)) throw new Error('FINANCIAL_SCAN_INVALID');
    return result;
  }
  async mintAt(mintAddress:string,expectedAuthority:string|null):Promise<{supply:bigint}> {
    const raw=await this.options.accounts.get(mintAddress);
    if (!raw || raw.ownerProgramId!==TOKEN_PROGRAM || raw.data.length!==82 || raw.data[44]!==6 || raw.data[45]!==1) throw new Error('TOKEN_MINT_UNAVAILABLE');
    const bytes=Buffer.from(raw.data),tag=bytes.readUInt32LE(0);
    if (expectedAuthority===null ? tag!==0 : tag!==1 || getBase58Decoder().decode(raw.data.subarray(4,36))!==expectedAuthority) throw new Error('TOKEN_MINT_AUTHORITY_MISMATCH');
    return {supply:bytes.readBigUInt64LE(36)};
  }
  async associatedToken(owner:string,mint:string):Promise<TokenAccountView> {
    const [pda]=await getProgramDerivedAddress({programAddress:address(ASSOCIATED_TOKEN_PROGRAM),
      seeds:[getAddressEncoder().encode(address(owner)),getAddressEncoder().encode(address(TOKEN_PROGRAM)),getAddressEncoder().encode(address(mint))]});
    const accountAddress=String(pda),raw=await this.options.accounts.get(accountAddress);
    if (!raw) return {address:accountAddress,mint,owner,amount:0n,exists:false};
    if (raw.ownerProgramId!==TOKEN_PROGRAM || raw.data.length!==165 || raw.data[108]!==1) throw new Error('TOKEN_ACCOUNT_UNAVAILABLE');
    const decodedMint=getBase58Decoder().decode(raw.data.subarray(0,32));
    const decodedOwner=getBase58Decoder().decode(raw.data.subarray(32,64));
    if (decodedMint!==mint || decodedOwner!==owner) throw new Error('TOKEN_ACCOUNT_IDENTITY_MISMATCH');
    return {address:accountAddress,mint,owner,amount:Buffer.from(raw.data).readBigUInt64LE(64),exists:true};
  }
  async tokenAt(accountAddress:string,mint:string,owner:string):Promise<TokenAccountView> {
    const raw=await this.options.accounts.get(accountAddress);
    if (!raw || raw.ownerProgramId!==TOKEN_PROGRAM || raw.data.length!==165 || raw.data[108]!==1) throw new Error('TOKEN_ACCOUNT_UNAVAILABLE');
    if (getBase58Decoder().decode(raw.data.subarray(0,32))!==mint || getBase58Decoder().decode(raw.data.subarray(32,64))!==owner) throw new Error('TOKEN_ACCOUNT_IDENTITY_MISMATCH');
    return {address:accountAddress,mint,owner,amount:Buffer.from(raw.data).readBigUInt64LE(64),exists:true};
  }
}

/** First B slice: only faucet, registration and curve quotes. Other actions remain closed. */
export class FirstSliceFinancialReader implements FinancialReader {
  readonly state:FinalizedFinancialAccounts;
  readonly registrations:SqliteFinancialRegistrationStore;
  readonly now:()=>number;
  readonly clock?:FinancialClock;
  constructor(state:FinalizedFinancialAccounts,registrations:SqliteFinancialRegistrationStore,now:()=>number=()=>Math.floor(Date.now()/1000),clock?:FinancialClock) {this.state=state;this.registrations=registrations;this.now=now;this.clock=clock;}
  async portfolio(wallet:string) {
    const scan=await this.state.programAccounts();if (!scan) return null;
    const finance=await this.state.financeConfig();
    const quote=await this.state.associatedToken(wallet,String(finance.paymentMint));
    const marketAddresses:string[]=[];
    const positionAddresses:string[]=[];
    for (const account of scan.accounts) {
      if (equal(account.data.subarray(0,8),FINANCE_MARKET_DISCRIMINATOR)) {
        const fm=getFinanceMarketDecoder().decode(account.data);
        const [expected]=await findFinanceMarketPda({market:fm.market},{programAddress:address(this.state.options.programId)});
        if (String(expected)!==account.address) throw new Error('FINANCIAL_MARKET_PDA_MISMATCH');
        marketAddresses.push(String(fm.market));
      }
      if (equal(account.data.subarray(0,8),PRO_POSITION_DISCRIMINATOR)) {
        const position=getProPositionDecoder().decode(account.data);
        if (String(position.owner)===wallet) positionAddresses.push(account.address);
      }
    }
    const tokenBalances:FinancialPortfolio['tokenBalances']=[],positions:FinancialPortfolio['positions']=[],claims:FinancialPortfolio['claims']=[],lpShares:FinancialPortfolio['lpShares']=[];
    for (const marketAddress of [...new Set(marketAddresses)]) {
      const fm=await this.state.financeMarket(marketAddress);
      const token=await this.state.associatedToken(wallet,String(fm.keywordMint));
      if (token.amount>0n) tokenBalances.push({marketId:marketAddress,mint:String(fm.keywordMint),atoms:token.amount.toString()});
      const holding=await this.state.holding(marketAddress,wallet);
      if (holding && holding.value.shares>0n) lpShares.push({marketId:marketAddress,sharesAtoms:holding.value.shares.toString(),withdrawableAtoms:null});
    }
    for (const positionAddress of positionAddresses) {
      const position=await this.state.position(positionAddress);
      if (!position || String(position.owner)!==wallet) throw new Error('PRO_POSITION_INVALID');
      const claim=await this.state.claim(positionAddress);
      if (claim && (String(claim.value.owner)!==wallet || String(claim.value.market)!==String(position.market)) ||
          position.state===PositionState.Settled && !claim || position.state===PositionState.Open && claim) throw new Error('PRO_CLAIM_IDENTITY_MISMATCH');
      positions.push({id:positionAddress,marketId:String(position.market),owner:wallet,
        direction:position.direction===PositionDirection.Long?'long':'short',collateralAtoms:position.collateral.toString(),
        notionalAtoms:position.notional.toString(),entryPriceAtoms:position.entryPrice.toString(),
        maxPayoutAtoms:position.maximumPayout.toString(),openedAt:Number(position.openedAt),maturityAt:Number(position.maturity),
        timePrepaidAtoms:position.prepaidFee.toString(),status:position.state===PositionState.Open?'OPEN':claim!.value.paid?'PAID':'SETTLED',
        claimId:claim?.address??null});
      if (claim) claims.push({id:claim.address,marketId:String(position.market),owner:wallet,positionId:positionAddress,
        payoutAtoms:claim.value.payout.toString(),refundAtoms:claim.value.refund.toString(),status:claim.value.paid?'PAID':'UNPAID'});
    }
    const value:FinancialPortfolio={wallet,quoteMint:String(finance.paymentMint),quoteBalanceAtoms:quote.amount.toString(),
      tokenBalances,positions,claims,lpShares};
    return {value,slot:scan.slot,cluster:this.state.options.cluster,programId:this.state.options.programId,finality:'finalized' as const};
  }
  async vault(marketId:string) {
    const scan=await this.state.programAccounts();if (!scan) return null;
    const [fm,market,finance]=await Promise.all([this.state.financeMarket(marketId),this.state.market(marketId),this.state.financeConfig()]);
    const [fmAddress]=await findFinanceMarketPda({market:address(marketId)},{programAddress:address(this.state.options.programId)});
    const vault=await this.state.tokenAt(String(fm.paymentVault),String(finance.paymentMint),String(fmAddress));
    const reserve=(fm.externalQ*fm.pmax+UNIT-1n)/UNIT;
    const free=freeCapital(vault.amount,fm.externalQ,fm.pmax,fm.proReserved,fm.otherReserved,500n*UNIT) as bigint;
    let nav:string|null=null;
    const s=market.latestNowQ12,d=market.latest7dQ12;
    const now=this.now();
    if (market.phase===MarketPhase.Indexed && fm.openPositions===0 &&
        (market.dataStatus===DataStatus.Valid || market.dataStatus===DataStatus.LowActivity) &&
        market.latestDataThrough<=BigInt(now) && BigInt(now)-market.latestDataThrough<600n && s.__option==='Some' && d.__option==='Some' && d.value>0n) {
      try {
        const price=indexPrice(fm.anchorPg,fm.anchorSg,fm.anchorDg,s.value,d.value);
        const debt=fm.externalQ*BigInt(price.price)/UNIT;
        const value=vault.amount-debt-fm.otherReserved;
        if (price.maximum===fm.pmax && value>=0n) nav=value.toString();
      } catch { /* Invalid price leaves NAV unavailable. */ }
    }
    const epochPhase=await financialEpochPhase(this.state,marketId,market,fm,now);
    const value:FinancialVault={marketId,assetsAtoms:vault.amount.toString(),outsideTokensAtoms:fm.externalQ.toString(),
      spotReserveAtoms:reserve.toString(),proReserveAtoms:fm.proReserved.toString(),otherReserveAtoms:fm.otherReserved.toString(),
      bufferAtoms:(500n*UNIT).toString(),freeCapitalAtoms:free.toString(),navAtoms:nav,
      totalSharesAtoms:fm.totalShares.toString(),lockedSharesAtoms:fm.lockedShares.toString(),epochPhase};
    return {value,slot:scan.slot,cluster:this.state.options.cluster,programId:this.state.options.programId,finality:'finalized' as const};
  }
  async registration(intent:FinancialIntent):Promise<DerivedRegistration|null> {
    if (intent.action!=='registerMarket') return null;
    const derived=await deriveRegistration(intent,this.state.options.programId);
    const pending=this.registrations.pending(intent.requestId);
    return pending && pending.address===derived.address && pending.queryHash===derived.queryHash ? pending : null;
  }
  /** Seal the validity window only after pricing/account reads have completed. */
  private async finishQuote(quote:FinancialQuote, view:MarketView|null=null, deadlineLimit=Number.MAX_SAFE_INTEGER):Promise<FinancialQuote> {
    let sample=null;
    try {sample=this.clock?await this.clock():null;} catch {throw new Error('REQUOTE_REQUIRED');}
    const quotedAt=this.now();
    const expiresAt=Math.min(sample?financialQuoteDeadline(quotedAt,quotedAt,sample):quotedAt+30,deadlineLimit);
    if (!Number.isSafeInteger(quotedAt) || !Number.isSafeInteger(expiresAt) || expiresAt<=quotedAt) throw new Error('REQUOTE_REQUIRED');
    // Latency must never turn an expired observation or closing phase into a fresh quote.
    if (quote.snapshot) {
      const snapshot=view?.snapshot;
      if (!snapshot || snapshot.payload.sequence!==quote.snapshot.sequence || snapshot.payloadHash!==quote.snapshot.payloadHash ||
          snapshot.payload.dataThrough>quotedAt || quotedAt-snapshot.payload.dataThrough>=600) throw new Error('DATA_NOT_READY');
    }
    if (quote.intent.action==='openPro' && (quote.maturityAt===null || quotedAt>=quote.maturityAt-1800)) throw new Error('REQUOTE_REQUIRED');
    return {...quote,quotedAt,expiresAt};
  }
  async quote(intent:FinancialIntent,market:MarketView|null,now:number):Promise<FinancialQuote|null> {
    if (!Number.isSafeInteger(now) || now<0) return null;
    if (!['faucet','registerMarket','curveBuy','curveSell','spotBuy','spotSell','openPro','closePro','claim','depositLP','withdrawLP'].includes(intent.action)) return null;
    const finance=await this.state.financeConfig();
    const [financeConfigAddress]=await findFinanceConfigPda({programAddress:address(this.state.options.programId)});
    await this.state.mintAt(String(finance.paymentMint),String(financeConfigAddress));
    if (intent.action!=='faucet') await this.state.tokenAt(String(finance.protocolTreasury),String(finance.paymentMint),String(finance.admin));
    const expiresAt=now+30; // Draft only; finishQuote seals time after the account reads.
    const base={id:randomUUID(),intent,chain:{cluster:this.state.options.cluster,programId:this.state.options.programId,address:this.state.options.programId},
      phase:null,quotedAt:now,expiresAt,configVersion:'0',snapshot:null,stateVersion:'0',priceAtoms:'0',grossAtoms:'0',
      tradeFeeAtoms:'0',timePrepaidAtoms:'0',maxPaymentAtoms:'0',minReceiveAtoms:'0',maxPayoutAtoms:null,maturityAt:null,executable:true} as FinancialQuote;
    if (intent.action==='faucet') {
      const receipt=await this.state.receipt(intent.wallet);
      if (finance.faucetAmount<=0n || !u64(finance.faucetAmount) || finance.faucetMinted+finance.faucetAmount>finance.faucetTotalLimit ||
          receipt && BigInt(now)-receipt.lastClaimAt<finance.faucetCooldown) return null;
      await this.state.associatedToken(intent.wallet,String(finance.paymentMint));
      const [pda]=await findFinanceConfigPda({programAddress:address(this.state.options.programId)});
      return this.finishQuote({...base,chain:{...base.chain,address:String(pda)},stateVersion:finance.faucetMinted.toString(),minReceiveAtoms:finance.faucetAmount.toString()});
    }
    if (intent.action==='registerMarket') {
      const entry=await deriveRegistration(intent,this.state.options.programId);
      const [marketPda]=await findMarketPda({marketId:Uint8Array.from(Buffer.from(entry.seedHex,'hex'))},{programAddress:address(this.state.options.programId)});
      if (await this.state.options.accounts.get(String(marketPda))) return null;
      const payment=await this.state.associatedToken(intent.wallet,String(finance.paymentMint));
      if (payment.amount<10n*UNIT) return null;
      const sealed=await this.finishQuote({...base,chain:{...base.chain,address:String(marketPda)},grossAtoms:(10n*UNIT).toString(),maxPaymentAtoms:(10n*UNIT).toString()});
      this.registrations.reserve(entry,intent.requestId,sealed.expiresAt,sealed.quotedAt);
      return sealed;
    }
    if (!market || !intent.marketId) return null;
    if (market.phase==='INDEXED' && ['spotBuy','spotSell','openPro','closePro','claim','depositLP','withdrawLP'].includes(intent.action))
      return this.indexedQuote(base,intent,market,finance,now);
    if (!['curveBuy','curveSell'].includes(intent.action) || market.phase!=='CURVE') return null;
    const [config,chainMarket,fm]=await Promise.all([this.state.config(),this.state.market(intent.marketId),this.state.financeMarket(intent.marketId)]);
    if (chainMarket.phase!==MarketPhase.Curve || !intent.quantityAtoms) return null;
    await this.state.mintAt(String(fm.keywordMint),null);
    const q=BigInt(intent.quantityAtoms),sold=fm.curveSold;
    const newSold=intent.action==='curveBuy'?sold+q:sold-q;
    if (newSold<0n || newSold>1000n*UNIT || !u64(newSold)) return null;
    const gross=curveGross(sold,newSold,intent.action==='curveBuy'?'buy':'sell') as bigint;
    const fee=tradeFee(gross) as {total:bigint;protocol:bigint;vault:bigint};
    const amount=intent.action==='curveBuy'?gross+fee.total:gross-fee.total;
    if (amount<=0n || !u64(amount)) return null;
    const payment=await this.state.associatedToken(intent.wallet,String(finance.paymentMint));
    const keyword=await this.state.associatedToken(intent.wallet,String(fm.keywordMint));
    const [fmPda]=await findFinanceMarketPda({market:address(intent.marketId)},{programAddress:address(this.state.options.programId)});
    const inventory=await this.state.tokenAt(String(fm.curveInventory),String(fm.keywordMint),String(fmPda));
    const vault=await this.state.tokenAt(String(fm.paymentVault),String(finance.paymentMint),String(fmPda));
    if (intent.action==='curveBuy' && (payment.amount<amount || inventory.amount<q) ||
        intent.action==='curveSell' && (keyword.amount<q || vault.amount<amount+fee.protocol)) return null;
    const price=UNIT+sold/5000n;
    return this.finishQuote({...base,chain:{...base.chain,address:intent.marketId},phase:'CURVE',configVersion:config.configVersion.toString(),
      stateVersion:fm.stateVersion.toString(),priceAtoms:price.toString(),grossAtoms:gross.toString(),tradeFeeAtoms:fee.total.toString(),
      maxPaymentAtoms:intent.action==='curveBuy'?amount.toString():'0',minReceiveAtoms:intent.action==='curveSell'?amount.toString():'0'});
  }
  private async indexedQuote(base:FinancialQuote,intent:FinancialIntent,view:MarketView,finance:FinanceConfig,now:number):Promise<FinancialQuote|null> {
    const marketId=intent.marketId!;
    const [config,market,fm]=await Promise.all([this.state.config(),this.state.market(marketId),this.state.financeMarket(marketId)]);
    if (market.phase!==MarketPhase.Indexed) return null;
    const [fmPda]=await findFinanceMarketPda({market:address(marketId)},{programAddress:address(this.state.options.programId)});
    const vault=await this.state.tokenAt(String(fm.paymentVault),String(finance.paymentMint),String(fmPda));
    const common={...base,chain:{...base.chain,address:marketId},phase:'INDEXED' as const,
      configVersion:config.configVersion.toString(),stateVersion:fm.stateVersion.toString()};
    if (intent.action==='claim') {
      if (!intent.claimId) return null;
      const verified=await this.state.claimByAddress(intent.claimId);
      if (!verified) return null;
      const position=await this.state.position(String(verified.value.position));
      if (!position || String(position.owner)!==intent.wallet || String(position.market)!==marketId ||
          String(verified.value.owner)!==intent.wallet || String(verified.value.market)!==marketId ||
          verified.value.paid || position.state!==PositionState.Settled) return null;
      const due=verified.value.payout+verified.value.refund;
      if (!u64(due) || due>fm.otherReserved || due>vault.amount) return null;
      await this.state.associatedToken(intent.wallet,String(finance.paymentMint));
      return this.finishQuote({...common,snapshot:null,minReceiveAtoms:due.toString(),grossAtoms:verified.value.payout.toString()});
    }
    const snapshot=view.snapshot;
    if (!snapshot || snapshot.finality!=='finalized' || snapshot.payload.sequence!==market.latestSequence.toString() ||
        snapshot.payloadHash!==Buffer.from(market.latestHash).toString('hex') || !market.latestNowQ12 || !market.latest7dQ12 ||
        market.latestNowQ12.__option!=='Some' || market.latest7dQ12.__option!=='Some' ||
        market.latestDataThrough>BigInt(now) || BigInt(now)-market.latestDataThrough>=600n ||
        ![DataStatus.Valid,DataStatus.LowActivity].includes(market.dataStatus) || market.latest7dQ12.value===0n) return null;
    let price:bigint;
    try {const calculated=indexPrice(fm.anchorPg,fm.anchorSg,fm.anchorDg,market.latestNowQ12.value,market.latest7dQ12.value);
      if (BigInt(calculated.maximum)!==fm.pmax) return null;price=BigInt(calculated.price);} catch {return null;}
    const entry=market.dataStatus===DataStatus.Valid && market.admission.state===AdmissionState.Open && price>0n;
    const lpAllowed=market.dataStatus===DataStatus.LowActivity || entry;
    const withPrice={...common,snapshot:{marketId,sequence:snapshot.payload.sequence,payloadHash:snapshot.payloadHash},priceAtoms:price.toString()};
    const payment=await this.state.associatedToken(intent.wallet,String(finance.paymentMint));
    if (intent.action==='spotBuy' || intent.action==='spotSell') {
      if (!intent.quantityAtoms || intent.action==='spotBuy' && !entry) return null;
      if ((await this.state.mintAt(String(fm.keywordMint),null)).supply>2_000n*UNIT) return null;
      const q=BigInt(intent.quantityAtoms),keyword=await this.state.associatedToken(intent.wallet,String(fm.keywordMint));
      const inventory=await this.state.tokenAt(String(fm.vaultInventory),String(fm.keywordMint),String(fmPda));
      const gross=intent.action==='spotBuy'?(q*price+UNIT-1n)/UNIT:q*price/UNIT;
      const fee=tradeFee(gross) as {total:bigint;protocol:bigint;vault:bigint};
      const amount=intent.action==='spotBuy'?gross+fee.total:gross-fee.total;
      if (amount<=0n || !u64(amount) || intent.action==='spotBuy' &&
          (inventory.amount<q || payment.amount<amount || freeCapital(vault.amount+gross+fee.vault,fm.externalQ+q,fm.pmax,fm.proReserved,fm.otherReserved,500n*UNIT)<0n) ||
          intent.action==='spotSell' && (keyword.amount<q || fm.externalQ<q || vault.amount<amount+fee.protocol)) return null;
      return this.finishQuote({...withPrice,grossAtoms:gross.toString(),tradeFeeAtoms:fee.total.toString(),
        maxPaymentAtoms:intent.action==='spotBuy'?amount.toString():'0',minReceiveAtoms:intent.action==='spotSell'?amount.toString():'0'},view);
    }
    if (intent.action==='openPro') {
      if (!entry || !intent.collateralAtoms || !intent.leverageBps || !intent.direction || view.epochPhase!=='PRO_OPEN' ||
          BigInt(now)<fm.proReopenAt || BigInt(now)<fm.lpWindowEnd) return null;
      const currentMonday=(BigInt(now)-345_600n)/604_800n*604_800n+345_600n;
      if (currentMonday>fm.lastLpMaturity || fm.currentMaturity===0n && fm.lpGeneration!==market.validityGeneration) return null;
      if (fm.currentMaturity>0n && await this.state.settlement(marketId,fm.currentCycle)) return null;
      const maturity=((BigInt(now)-345_600n)/604_800n+1n)*604_800n+345_600n;
      if (BigInt(now)>=maturity-1800n || fm.currentMaturity!==0n && fm.currentMaturity!==maturity) return null;
      const terms=pro(BigInt(intent.collateralAtoms),BigInt(intent.leverageBps),price,price,fm.pmax,intent.direction) as unknown as
        {notional:bigint;payout:bigint;reserve:bigint;capital:bigint};
      const fee=tradeFee(terms.notional) as {total:bigint;protocol:bigint;vault:bigint};
      const prepaid=(timeFee(terms.capital,terms.notional,maturity-BigInt(now),0n) as {prepaid:bigint}).prepaid;
      const total=BigInt(intent.collateralAtoms)+fee.total+prepaid;
      if (![terms.notional,terms.reserve,terms.capital,prepaid,total].every(u64) || payment.amount<total || freeCapital(vault.amount+BigInt(intent.collateralAtoms)+fee.vault+prepaid,
          fm.externalQ,fm.pmax,fm.proReserved+terms.reserve,fm.otherReserved+prepaid,500n*UNIT)<0n) return null;
      return this.finishQuote({...withPrice,grossAtoms:terms.notional.toString(),tradeFeeAtoms:fee.total.toString(),timePrepaidAtoms:prepaid.toString(),
        maxPaymentAtoms:total.toString(),maxPayoutAtoms:terms.reserve.toString(),maturityAt:Number(maturity)},view,Number(maturity-1801n));
    }
    if (intent.action==='closePro') {
      if (!intent.positionId || !view.epochPhase || view.epochPhase==='SETTLING') return null;
      const position=await this.state.position(intent.positionId);
      if (!position || String(position.owner)!==intent.wallet || String(position.market)!==marketId ||
          position.state!==PositionState.Open || BigInt(now)>=position.maturity || await this.state.settlement(marketId,position.cycle)) return null;
      const terms=pro(position.collateral,position.leverageBps,position.entryPrice,price,fm.pmax,
        position.direction===PositionDirection.Long?'long':'short') as {payout:bigint;reserve:bigint;notional:bigint};
      // Refund keeps decreasing while the wallet approves. Quote a lower bound
      // through the last executable second, while preserving exact price/state guards.
      const sealed=await this.finishQuote(withPrice,view,Number(position.maturity-1n));
      const expiresAt=sealed.expiresAt;
      const fee=timeFee(position.capital,position.notional,position.maturity-position.openedAt,BigInt(expiresAt)-position.openedAt) as {prepaid:bigint;refund:bigint};
      if (terms.reserve!==position.maximumPayout || terms.notional!==position.notional || fee.prepaid!==position.prepaidFee) return null;
      const due=terms.payout+fee.refund;
      return {...sealed,grossAtoms:terms.payout.toString(),timePrepaidAtoms:position.prepaidFee.toString(),minReceiveAtoms:due.toString()};
    }
    if (intent.action==='depositLP' || intent.action==='withdrawLP') {
      if (!lpAllowed || !intent.quantityAtoms || !['LP_WINDOW','INITIAL_LP'].includes(view.epochPhase??'') ||
          fm.openPositions!==0 || BigInt(now)<fm.lpWindowStart || BigInt(now)>=fm.lpWindowEnd || fm.lpGeneration!==market.validityGeneration) return null;
      const spotDebt=fm.externalQ*price/UNIT,nav=vault.amount-spotDebt-fm.otherReserved,q=BigInt(intent.quantityAtoms);
      if (nav<=0n || fm.totalShares<=0n) return null;
      if (intent.action==='depositLP') {
        const shares=q*fm.totalShares/nav;
        if (shares<=0n || !u64(shares) || payment.amount<q || freeCapital(vault.amount+q,fm.externalQ,fm.pmax,fm.proReserved,fm.otherReserved,500n*UNIT)<0n) return null;
        return this.finishQuote({...withPrice,grossAtoms:q.toString(),maxPaymentAtoms:q.toString(),minReceiveAtoms:shares.toString()},view,Number(fm.lpWindowEnd-1n));
      }
      const holding=await this.state.holding(marketId,intent.wallet),payout=q*nav/fm.totalShares;
      if (!holding || holding.value.shares<q || payout<=0n || !u64(payout) || payout>vault.amount || fm.totalShares-q<fm.lockedShares ||
          freeCapital(vault.amount-payout,fm.externalQ,fm.pmax,fm.proReserved,fm.otherReserved,500n*UNIT)<0n) return null;
      return this.finishQuote({...withPrice,grossAtoms:payout.toString(),minReceiveAtoms:payout.toString()},view,Number(fm.lpWindowEnd-1n));
    }
    return null;
  }
}
