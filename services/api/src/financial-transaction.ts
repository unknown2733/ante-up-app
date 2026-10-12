import { AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage,
  decompileTransactionMessage, getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Blockhash, type Instruction, type ReadonlyUint8Array } from '@solana/kit';
import { createHash } from 'node:crypto';
import { getClaimFaucetInstructionAsync, getRegisterFinancialMarketInstructionAsync, getCurveBuyInstructionAsync,
  getCurveSellInstructionAsync, getSpotBuyInstructionAsync, getSpotSellInstructionAsync, getOpenProInstructionAsync,
  getCloseProInstructionAsync, getClaimProInstructionAsync, getDepositLpInstructionAsync, getWithdrawLpInstructionAsync,
  PositionDirection, PositionState, findReceiptPda, findFinanceMarketPda, findPositionPda, findClaimPda, findHoldingPda } from '../../../clients/chain/dist/index.js';
import type { FinancialQuote } from '../../../contracts/financial.ts';
import { financialQuoteKey, type FinancialTransactionAdapter, type PreparedFinancialTransaction } from './financial.ts';
import { ASSOCIATED_TOKEN_PROGRAM, TOKEN_PROGRAM, FinalizedFinancialAccounts, FirstSliceFinancialReader } from './financial-chain.ts';
import type { BlockhashProvider } from './transaction.ts';

const equal=(a:ReadonlyUint8Array,b:ReadonlyUint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const usable=(quote:FinancialQuote,now:number)=>quote.executable && quote.expiresAt>now && quote.expiresAt<=quote.quotedAt+30;
const SYSTEM_PROGRAM='11111111111111111111111111111111';
export const positionIdForRequest=(requestId:string):bigint=>createHash('sha256').update(`ante-up-pro-position-v1:${requestId}`).digest().readBigUInt64LE(0);

/** SPL Associated Token Account program's CreateIdempotent instruction. */
function ensureAta(wallet:string,mint:string,ata:string):Instruction {
  const payer=address(wallet);
  return {programAddress:address(ASSOCIATED_TOKEN_PROGRAM),data:Uint8Array.of(1),accounts:[
    {address:payer,role:AccountRole.WRITABLE_SIGNER},
    {address:address(ata),role:AccountRole.WRITABLE},
    {address:payer,role:AccountRole.READONLY},
    {address:address(mint),role:AccountRole.READONLY},
    {address:address(SYSTEM_PROGRAM),role:AccountRole.READONLY},
    {address:address(TOKEN_PROGRAM),role:AccountRole.READONLY}
  ]};
}

/** Generated B instructions only. No server signer or broadcast method exists here. */
export class KitFirstSliceFinancialTransactionAdapter implements FinancialTransactionAdapter {
  readonly options:{state:FinalizedFinancialAccounts;reader:FirstSliceFinancialReader;blockhashes:BlockhashProvider;now:()=>number};
  constructor(options:{state:FinalizedFinancialAccounts;reader:FirstSliceFinancialReader;blockhashes:BlockhashProvider;now:()=>number}) {this.options=options;}
  private async instructions(quote:FinancialQuote):Promise<Instruction[]> {
    const {state}=this.options,programAddress=address(state.options.programId),wallet=address(quote.intent.wallet);
    const finance=await state.financeConfig();
    if (quote.chain.cluster!==state.options.cluster || quote.chain.programId!==state.options.programId) throw new Error('FINANCIAL_NETWORK_MISMATCH');
    if (quote.intent.action==='faucet') {
      if (finance.faucetMinted.toString()!==quote.stateVersion || finance.faucetAmount.toString()!==quote.minReceiveAtoms) throw new Error('REQUOTE_REQUIRED');
      const [receipt]=await findReceiptPda({wallet},{programAddress});
      const recipient=await state.associatedToken(String(wallet),String(finance.paymentMint));
      const ix=await getClaimFaucetInstructionAsync({paymentMint:finance.paymentMint,recipientPayment:address(recipient.address),
        receipt,wallet:createNoopSigner(wallet)},{programAddress});
      return recipient.exists===false ? [ensureAta(String(wallet),String(finance.paymentMint),recipient.address),ix] : [ix];
    }
    if (quote.intent.action==='registerMarket') {
      const entry=await this.options.reader.registration(quote.intent);
      if (!entry) throw new Error('REGISTRATION_METADATA_UNAVAILABLE');
      const payment=await state.associatedToken(String(wallet),String(finance.paymentMint));
      if (payment.exists===false) throw new Error('REGISTRATION_PAYMENT_UNAVAILABLE');
      return [await getRegisterFinancialMarketInstructionAsync({paymentMint:finance.paymentMint,registrantPayment:address(payment.address),
        protocolTreasury:finance.protocolTreasury,registrant:createNoopSigner(wallet),
        marketId:Uint8Array.from(Buffer.from(entry.seedHex,'hex')),queryHash:Uint8Array.from(Buffer.from(entry.queryHash,'hex')),
        queryVersion:BigInt(entry.queryVersion)},{programAddress})];
    }
    if (quote.intent.action==='curveBuy' || quote.intent.action==='curveSell') {
      const marketId=quote.intent.marketId;
      if (!marketId || !quote.intent.quantityAtoms) throw new Error('CURVE_QUOTE_INVALID');
      const [market,fm,config]=await Promise.all([state.market(marketId),state.financeMarket(marketId),state.config()]);
      if (market.phase!==0 || fm.stateVersion.toString()!==quote.stateVersion || config.configVersion.toString()!==quote.configVersion) throw new Error('REQUOTE_REQUIRED');
      const payment=await state.associatedToken(String(wallet),String(finance.paymentMint));
      const keyword=await state.associatedToken(String(wallet),String(fm.keywordMint));
      const common={market:address(marketId),keywordMint:fm.keywordMint,curveInventory:fm.curveInventory,
        paymentVault:fm.paymentVault,paymentMint:finance.paymentMint,userKeyword:address(keyword.address),userPayment:address(payment.address),
        protocolTreasury:finance.protocolTreasury,user:createNoopSigner(wallet),quantity:BigInt(quote.intent.quantityAtoms),
        expectedSequence:0n,expectedConfigVersion:config.configVersion,expectedStateVersion:fm.stateVersion,
        deadline:BigInt(quote.expiresAt)};
      const buy=quote.intent.action==='curveBuy';
      if (buy && payment.exists===false || !buy && keyword.exists===false) throw new Error('CURVE_SOURCE_UNAVAILABLE');
      const ix=buy ?
        await getCurveBuyInstructionAsync({...common,maxPayment:BigInt(quote.maxPaymentAtoms)},{programAddress}) :
        await getCurveSellInstructionAsync({...common,minReceipt:BigInt(quote.minReceiveAtoms)},{programAddress});
      const destination=buy?keyword:payment;
      return destination.exists===false ? [ensureAta(String(wallet),destination.mint,destination.address),ix] : [ix];
    }
    if (['spotBuy','spotSell','openPro','closePro','claim','depositLP','withdrawLP'].includes(quote.intent.action)) {
      const marketId=quote.intent.marketId;
      if (!marketId) throw new Error('FINANCIAL_MARKET_REQUIRED');
      const [market,fm,config]=await Promise.all([state.market(marketId),state.financeMarket(marketId),state.config()]);
      if (market.phase!==2 || fm.stateVersion.toString()!==quote.stateVersion || config.configVersion.toString()!==quote.configVersion)
        throw new Error('REQUOTE_REQUIRED');
      if (quote.intent.action!=='claim' && (!quote.snapshot || market.latestSequence.toString()!==quote.snapshot.sequence ||
          Buffer.from(market.latestHash).toString('hex')!==quote.snapshot.payloadHash)) throw new Error('REQUOTE_REQUIRED');
      const payment=await state.associatedToken(String(wallet),String(finance.paymentMint));
      const common={market:address(marketId),paymentMint:finance.paymentMint,paymentVault:fm.paymentVault,
        expectedSequence:market.latestSequence,expectedConfigVersion:config.configVersion,
        expectedStateVersion:fm.stateVersion,deadline:BigInt(quote.expiresAt)};
      if (quote.intent.action==='spotBuy' || quote.intent.action==='spotSell') {
        const keyword=await state.associatedToken(String(wallet),String(fm.keywordMint));
        const buy=quote.intent.action==='spotBuy';
        if (buy && payment.exists===false || !buy && keyword.exists===false) throw new Error('SPOT_SOURCE_UNAVAILABLE');
        const trade={...common,keywordMint:fm.keywordMint,vaultInventory:fm.vaultInventory,
          userKeyword:address(keyword.address),userPayment:address(payment.address),protocolTreasury:finance.protocolTreasury,
          user:createNoopSigner(wallet),quantity:BigInt(quote.intent.quantityAtoms!)};
        const ix=buy?await getSpotBuyInstructionAsync({...trade,maxPayment:BigInt(quote.maxPaymentAtoms)},{programAddress}):
          await getSpotSellInstructionAsync({...trade,minReceipt:BigInt(quote.minReceiveAtoms)},{programAddress});
        const destination=buy?keyword:payment;
        return destination.exists===false?[ensureAta(String(wallet),destination.mint,destination.address),ix]:[ix];
      }
      if (quote.intent.action==='openPro') {
        if (payment.exists===false || !quote.intent.direction) throw new Error('PRO_PAYMENT_UNAVAILABLE');
        const positionId=positionIdForRequest(quote.intent.requestId);
        const [position]=await findPositionPda({market:address(marketId),owner:wallet,positionId},{programAddress});
        if (await state.options.accounts.get(String(position))) throw new Error('PRO_POSITION_ALREADY_EXISTS');
        return [await getOpenProInstructionAsync({...common,position,paymentVault:fm.paymentVault,
          ownerPayment:address(payment.address),protocolTreasury:finance.protocolTreasury,owner:createNoopSigner(wallet),
          positionId,collateral:BigInt(quote.intent.collateralAtoms!),leverageBps:BigInt(quote.intent.leverageBps!),
          direction:quote.intent.direction==='long'?PositionDirection.Long:PositionDirection.Short,
          maxPayment:BigInt(quote.maxPaymentAtoms)},{programAddress})];
      }
      if (quote.intent.action==='closePro') {
        const positionAddress=quote.intent.positionId;
        if (!positionAddress) throw new Error('PRO_POSITION_REQUIRED');
        const position=await state.position(positionAddress);
        if (!position || String(position.owner)!==String(wallet) || String(position.market)!==marketId || position.state!==PositionState.Open)
          throw new Error('PRO_POSITION_UNAVAILABLE');
        const [claim]=await findClaimPda({position:address(positionAddress)},{programAddress});
        const settlement=await state.settlementAddress(marketId,position.cycle);
        if (await state.options.accounts.get(String(claim)) || await state.settlement(marketId,position.cycle)) throw new Error('REQUOTE_REQUIRED');
        return [await getCloseProInstructionAsync({market:address(marketId),position:address(positionAddress),claim,
          settlement:address(settlement),owner:createNoopSigner(wallet),minReceipt:BigInt(quote.minReceiveAtoms),
          expectedSequence:market.latestSequence,expectedConfigVersion:config.configVersion,
          expectedStateVersion:fm.stateVersion,deadline:BigInt(quote.expiresAt)},{programAddress})];
      }
      if (quote.intent.action==='claim') {
        const claimAddress=quote.intent.claimId,claim=claimAddress?await state.claimByAddress(claimAddress):null;
        if (!claim || String(claim.value.owner)!==String(wallet) || String(claim.value.market)!==marketId || claim.value.paid)
          throw new Error('PRO_CLAIM_UNAVAILABLE');
        const ix=await getClaimProInstructionAsync({market:address(marketId),position:claim.value.position,
          claim:address(claim.address),paymentMint:finance.paymentMint,paymentVault:fm.paymentVault,
          ownerPayment:address(payment.address),owner:createNoopSigner(wallet)},{programAddress});
        return payment.exists===false?[ensureAta(String(wallet),String(finance.paymentMint),payment.address),ix]:[ix];
      }
      const [holding]=await findHoldingPda({market:address(marketId),owner:wallet},{programAddress});
      const lp={...common,holding,ownerPayment:address(payment.address),owner:createNoopSigner(wallet)};
      if (quote.intent.action==='depositLP') {
        if (payment.exists===false) throw new Error('LP_PAYMENT_UNAVAILABLE');
        return [await getDepositLpInstructionAsync({...lp,amount:BigInt(quote.intent.quantityAtoms!),
          minShares:BigInt(quote.minReceiveAtoms)},{programAddress})];
      }
      const ix=await getWithdrawLpInstructionAsync({...lp,shares:BigInt(quote.intent.quantityAtoms!),
        minReceipt:BigInt(quote.minReceiveAtoms)},{programAddress});
      return payment.exists===false?[ensureAta(String(wallet),String(finance.paymentMint),payment.address),ix]:[ix];
    }
    throw new Error('FINANCIAL_ACTION_NOT_IMPLEMENTED');
  }
  async prepare(quote:FinancialQuote) {
    const now=this.options.now();
    if (!usable(quote,now)) throw new Error('REQUOTE_REQUIRED');
    const instructions=await this.instructions(quote);
    const block=await this.options.blockhashes.latest();
    const message=appendTransactionMessageInstructions(instructions,
      setTransactionMessageLifetimeUsingBlockhash({blockhash:block.blockhash as Blockhash,lastValidBlockHeight:block.lastValidBlockHeight},
        setTransactionMessageFeePayer(address(quote.intent.wallet),createTransactionMessage({version:0}))));
    const unsignedTransaction=Buffer.from(getTransactionEncoder().encode(compileTransaction(message))).toString('base64');
    const prepared:PreparedFinancialTransaction={kind:'transaction',action:quote.intent.action,requestId:quote.intent.requestId,wallet:quote.intent.wallet,
      cluster:this.options.state.options.cluster,programId:this.options.state.options.programId,expiresAt:quote.expiresAt,
      unsignedTransaction,lastValidBlockHeight:block.lastValidBlockHeight.toString(),quote};
    const programAddress=address(this.options.state.options.programId);
    const discoveryAddress=quote.intent.action==='faucet' ? String((await findReceiptPda({wallet:address(quote.intent.wallet)},{programAddress}))[0]) :
      quote.intent.action==='registerMarket' ? quote.chain.address :
      quote.intent.action==='openPro' ? String((await findPositionPda({market:address(quote.intent.marketId!),owner:address(quote.intent.wallet),positionId:positionIdForRequest(quote.intent.requestId)},{programAddress}))[0]) :
      quote.intent.action==='closePro' ? String((await findClaimPda({position:address(quote.intent.positionId!)},{programAddress}))[0]) :
      quote.intent.action==='claim' ? quote.intent.claimId! :
      quote.intent.action==='depositLP' || quote.intent.action==='withdrawLP' ? String((await findHoldingPda({market:address(quote.intent.marketId!),owner:address(quote.intent.wallet)},{programAddress}))[0]) :
      String((await findFinanceMarketPda({market:address(quote.intent.marketId!)},{programAddress}))[0]);
    return {prepared,discoveryAddress};
  }
  async verifyCompiled(prepared:PreparedFinancialTransaction,quote:FinancialQuote):Promise<void> {
    if (financialQuoteKey(prepared.quote)!==financialQuoteKey(quote)) throw new Error('FINANCIAL_QUOTE_MISMATCH');
    const transaction=getTransactionDecoder().decode(Buffer.from(prepared.unsignedTransaction,'base64'));
    const actual=decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(transaction.messageBytes));
    const expected=await this.instructions(quote);
    if (!('blockhash' in actual.lifetimeConstraint)) throw new Error('FINANCIAL_GENERATED_INSTRUCTION_MISMATCH');
    const rebuilt=compileTransaction(appendTransactionMessageInstructions(expected,
      setTransactionMessageLifetimeUsingBlockhash({blockhash:actual.lifetimeConstraint.blockhash,lastValidBlockHeight:BigInt(prepared.lastValidBlockHeight)},
        setTransactionMessageFeePayer(address(quote.intent.wallet),createTransactionMessage({version:0})))));
    if (!equal(transaction.messageBytes,rebuilt.messageBytes)) throw new Error('FINANCIAL_GENERATED_INSTRUCTION_MISMATCH');
  }
}
