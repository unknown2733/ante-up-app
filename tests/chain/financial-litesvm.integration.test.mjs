import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {
  ANTE_UP_PROGRAM_ADDRESS, AdmissionState, DataStatus, PositionDirection, SettlementMode,
  findFinanceConfigPda, findFinanceMarketPda, findMarketPda, findKeywordMintPda,
  findCurveInventoryPda, findVaultInventoryPda, findPaymentVaultPda, findPositionPda,
  findClaimPda, findHoldingPda, findSnapshotPda, findSettlementPda,
  getFinanceMarketDecoder, getProClaimDecoder, getLpHoldingDecoder,
  getInitializeInstructionAsync, getInitializeFinanceInstructionAsync,
  getClaimFaucetInstructionAsync, getRegisterFinancialMarketInstructionAsync,
  getCurveBuyInstructionAsync, getCurveSellInstructionAsync, getGraduateInstructionAsync,
  getSpotBuyInstructionAsync, getSpotSellInstructionAsync, getOpenProInstructionAsync,
  getCloseProInstructionAsync, getClaimProInstructionAsync, getAcceptSettlementInstructionAsync,
  getSettleProInstructionAsync, getStartLpWindowInstructionAsync,
  getDepositLpInstructionAsync, getWithdrawLpInstructionAsync,
  getPublishSnapshotInstructionAsync,
} from '../../clients/chain/dist/index.js';
import {formulaVersionBytes} from '../../clients/chain/encoding.mjs';

const requireChain = createRequire(new URL('../../clients/chain/package.json', import.meta.url));
const binary = process.env.ANTE_UP_SBF_PATH ?? resolve(import.meta.dirname, '../../target/deploy/ante_up.so');
const UNIT = 1_000_000n;
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const QNOW = 125_000_000_000_000n;
const Q7D = 100_000_000_000_000n;

test('LiteSVM financial cycle moves SPL assets and enforces reservations and single claims',
  {skip: !existsSync(binary) && 'A compiled Solana SBF .so is required via ANTE_UP_SBF_PATH'},
  async () => {
    // The seeded tUSD mint and owner accounts represent local test funding. Every
    // faucet, trade, support, Pro, claim and LP movement below executes real SPL CPI.
    const {LiteSVM, FailedTransactionMetadata} = requireChain('litesvm');
    const kit = requireChain('@solana/kit');
    const {generateKeyPairSigner, lamports, getAddressEncoder, pipe,
      createTransactionMessage, setTransactionMessageFeePayerSigner,
      appendTransactionMessageInstruction, signTransactionMessageWithSigners} = kit;
    const svm = new LiteSVM();
    svm.addProgramFromFile(ANTE_UP_PROGRAM_ADDRESS, binary);
    const admin = await generateKeyPairSigner();
    const paymentMint = (await generateKeyPairSigner()).address;
    const adminPayment = (await generateKeyPairSigner()).address;
    const treasury = (await generateKeyPairSigner()).address;
    const userKeyword = (await generateKeyPairSigner()).address;
    svm.airdrop(admin.address, lamports(30_000_000_000n));
    const clock = svm.getClock(); clock.unixTimestamp = 1_800_000_000n; svm.setClock(clock);
    const [financeConfig] = await findFinanceConfigPda({});
    const addressBytes = value => getAddressEncoder().encode(value);
    const write64 = (bytes, offset, value) => new DataView(bytes.buffer).setBigUint64(offset, value, true);
    const read64 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(offset, true);
    const put = (address, data) => svm.setAccount({address, programAddress: TOKEN,
      lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
      space: BigInt(data.length), data, executable: false});
    const mintData = new Uint8Array(82);
    new DataView(mintData.buffer).setUint32(0, 1, true);
    mintData.set(addressBytes(financeConfig), 4);
    write64(mintData, 36, 100_000n * UNIT);
    mintData[44] = 6; mintData[45] = 1;
    put(paymentMint, mintData);
    function tokenAccount(address, mint, owner, amount = 0n) {
      const data = new Uint8Array(165);
      data.set(addressBytes(mint), 0); data.set(addressBytes(owner), 32);
      write64(data, 64, amount); data[108] = 1;
      put(address, data);
    }
    tokenAccount(adminPayment, paymentMint, admin.address, 100_000n * UNIT);
    tokenAccount(treasury, paymentMint, admin.address);
    const tokenBalance = address => read64(svm.getAccount(address).data, 64);
    const finance = address => getFinanceMarketDecoder().decode(svm.getAccount(address).data);
    function advance(seconds) {
      const next = svm.getClock(); next.unixTimestamp += BigInt(seconds); svm.setClock(next);
    }
    async function send(ix, failure = false) {
      svm.expireBlockhash();
      const tx = await pipe(createTransactionMessage({version: 0}),
        m => setTransactionMessageFeePayerSigner(admin, m),
        m => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
        m => appendTransactionMessageInstruction(ix, m),
        m => signTransactionMessageWithSigners(m));
      const result = svm.sendTransaction(tx);
      if (failure) assert.ok(result instanceof FailedTransactionMetadata, 'expected transaction failure');
      else if (result instanceof FailedTransactionMetadata) throw new Error(`LiteSVM transaction failed: ${result.err()}`);
      return result;
    }
    const now = () => svm.getClock().unixTimestamp;
    const quote = fm => ({expectedSequence: currentSequence, expectedConfigVersion: 1n,
      expectedStateVersion: finance(fm).stateVersion, deadline: now() + 30n});
    let currentSequence = 0n;
    const marketId = new Uint8Array(32).fill(11);
    const queryHash = new Uint8Array(32).fill(12);
    const [market] = await findMarketPda({marketId});
    const [fm] = await findFinanceMarketPda({market});
    const [keywordMint] = await findKeywordMintPda({market});
    const [curveInventory] = await findCurveInventoryPda({market});
    const [vaultInventory] = await findVaultInventoryPda({market});
    const [paymentVault] = await findPaymentVaultPda({market});
    await send(await getInitializeInstructionAsync({admin, publisher: admin.address,
      proofAuthority: admin.address, formulaVersion: formulaVersionBytes('h3-d7-q12-v1')}));
    await send(await getInitializeFinanceInstructionAsync({admin, paymentMint, protocolTreasury: treasury,
      faucetAmount: 1_000n * UNIT, faucetCooldown: 86_400n, faucetTotalLimit: 10_000n * UNIT}));
    await send(await getClaimFaucetInstructionAsync({wallet: admin, paymentMint, recipientPayment: adminPayment}));
    assert.equal(tokenBalance(adminPayment), 101_000n * UNIT);
    await send(await getClaimFaucetInstructionAsync({wallet: admin, paymentMint, recipientPayment: adminPayment}), true);
    await send(await getRegisterFinancialMarketInstructionAsync({registrant: admin, marketId, queryHash,
      queryVersion: 1n, paymentMint, registrantPayment: adminPayment, protocolTreasury: treasury}));
    assert.equal(tokenBalance(treasury), 10n * UNIT);
    assert.equal(read64(svm.getAccount(keywordMint).data, 36), 2_000n * UNIT);
    const keywordBytes = svm.getAccount(keywordMint).data;
    assert.equal(new DataView(keywordBytes.buffer, keywordBytes.byteOffset).getUint32(0, true), 0);
    tokenAccount(userKeyword, keywordMint, admin.address);
    const curveAccounts = {market, keywordMint, curveInventory, paymentVault, paymentMint,
      userKeyword, userPayment: adminPayment, protocolTreasury: treasury, user: admin};
    await send(await getCurveBuyInstructionAsync({...curveAccounts, quantity: 1_000n * UNIT,
      maxPayment: 2_000n * UNIT, ...quote(fm)}));
    assert.equal(tokenBalance(userKeyword), 1_000n * UNIT);
    assert.equal(finance(fm).curveSold, 1_000n * UNIT);
    await send(await getCurveBuyInstructionAsync({...curveAccounts, quantity: UNIT,
      maxPayment: 10n * UNIT, ...quote(fm)}), true);
    // A sell and rebuy exercise both directions without weakening the 1000 cap.
    await send(await getCurveSellInstructionAsync({...curveAccounts, quantity: UNIT,
      minReceipt: 0n, ...quote(fm)}));
    await send(await getCurveBuyInstructionAsync({...curveAccounts, quantity: UNIT,
      maxPayment: 10n * UNIT, ...quote(fm)}));
    async function snapshot(sequence) {
      await send(await getPublishSnapshotInstructionAsync({market, publisher: admin, sequence,
        queryHash, queryVersion: 1n, configVersion: 1n,
        formulaVersion: formulaVersionBytes('h3-d7-q12-v1'), dataThrough: now() - 60n,
        activityNowQ12: QNOW, activity7dQ12: Q7D, dataStatus: DataStatus.Valid,
        admission: {state: AdmissionState.Open, recoveryCount: 0, reason: null},
        evidenceHash: new Uint8Array(32).fill(13), payloadHash: new Uint8Array(32).fill(Number(sequence) + 13)}));
      currentSequence = sequence;
    }
    await snapshot(1n);
    const [snap1] = await findSnapshotPda({market, sequence: 1n});
    await send(await getGraduateInstructionAsync({market, snapshot: snap1, paymentMint,
      paymentVault, supportPayment: adminPayment, admin, maxContribution: 10_000n * UNIT,
      ...quote(fm)}));
    assert.equal(finance(fm).externalQ, 1_000n * UNIT);
    assert.equal(finance(fm).lockedShares, finance(fm).totalShares);
    const spotAccounts = {market, keywordMint, vaultInventory, paymentVault, paymentMint,
      userKeyword, userPayment: adminPayment, protocolTreasury: treasury, user: admin};
    await send(await getSpotBuyInstructionAsync({...spotAccounts, quantity: 10n * UNIT,
      maxPayment: 100n * UNIT, ...quote(fm)}));
    assert.equal(finance(fm).externalQ, 1_010n * UNIT);
    await send(await getSpotSellInstructionAsync({...spotAccounts, quantity: 10n * UNIT,
      minReceipt: 0n, ...quote(fm)}));
    assert.equal(finance(fm).externalQ, 1_000n * UNIT);
    // Periodic valid snapshots keep the initial 900-second LP lock continuous.
    advance(450); await snapshot(2n);
    advance(451); await snapshot(3n);
    const proAccounts = {market, paymentMint, paymentVault, ownerPayment: adminPayment,
      protocolTreasury: treasury, owner: admin};
    async function open(id, direction) {
      await send(await getOpenProInstructionAsync({...proAccounts, positionId: id,
        collateral: 100n * UNIT, leverageBps: 10_000n, direction,
        maxPayment: 110n * UNIT, ...quote(fm)}));
      const [position] = await findPositionPda({market, owner: admin.address, positionId: id});
      return position;
    }
    const long = await open(1n, PositionDirection.Long);
    const short = await open(2n, PositionDirection.Short);
    const maturity = finance(fm).currentMaturity;
    assert.equal(finance(fm).openPositions, 2);
    assert.ok(finance(fm).proReserved > 0n);
    const [settlement] = await findSettlementPda(market, finance(fm).currentCycle);
    async function closeAndClaim(position) {
      await send(await getCloseProInstructionAsync({market, position, settlement, owner: admin,
        minReceipt: 0n, ...quote(fm)}));
      const [claim] = await findClaimPda({position});
      const frozen = getProClaimDecoder().decode(svm.getAccount(claim).data);
      const before = tokenBalance(adminPayment);
      await send(await getClaimProInstructionAsync({market, position, paymentMint,
        paymentVault, ownerPayment: adminPayment, owner: admin}));
      assert.equal(tokenBalance(adminPayment) - before, frozen.payout + frozen.refund);
      assert.equal(getProClaimDecoder().decode(svm.getAccount(claim).data).paid, true);
      await send(await getClaimProInstructionAsync({market, position, paymentMint,
        paymentVault, ownerPayment: adminPayment, owner: admin}), true);
    }
    await closeAndClaim(long);
    await closeAndClaim(short);
    assert.equal(finance(fm).openPositions, 0);
    assert.equal(finance(fm).proReserved, 0n);
    // A third position proves the immutable maturity settlement and keeper path.
    const finalPosition = await open(3n, PositionDirection.Long);
    advance(Number(maturity + 900n - now()));
    await snapshot(4n);
    await send(await getAcceptSettlementInstructionAsync({market, settlement, publisher: admin,
      epoch: 1n, maturityAt: maturity, candidateHash: new Uint8Array(32).fill(21),
      evidenceHash: new Uint8Array(32).fill(22), mode: SettlementMode.Normal,
      eligibleAt: maturity + 900n, effectiveCloseAt: maturity, outageStartedAt: 0n,
      settlementPrice: 1_200_000n, activityNowQ12: QNOW, activity7dQ12: Q7D,
      queryVersion: 1n, expectedConfigVersion: 1n}));
    await send(await getSettleProInstructionAsync({market, position: finalPosition, settlement,
      keeper: admin}));
    await send(await getClaimProInstructionAsync({market, position: finalPosition,
      paymentMint, paymentVault, ownerPayment: adminPayment, owner: admin}));
    assert.equal(finance(fm).openPositions, 0);
    await send(await getStartLpWindowInstructionAsync({market, settlement, publisher: admin}));
    const lpAccounts = {market, paymentMint, paymentVault, ownerPayment: adminPayment, owner: admin};
    const [holding] = await findHoldingPda({market, owner: admin.address});
    const vaultBefore = tokenBalance(paymentVault);
    await send(await getDepositLpInstructionAsync({...lpAccounts, amount: 200n * UNIT,
      minShares: 1n, ...quote(fm)}));
    assert.equal(tokenBalance(paymentVault), vaultBefore + 200n * UNIT);
    const minted = getLpHoldingDecoder().decode(svm.getAccount(holding).data).shares;
    assert.ok(minted > 0n);
    await send(await getWithdrawLpInstructionAsync({...lpAccounts, shares: minted,
      minReceipt: 1n, ...quote(fm)}));
    assert.equal(getLpHoldingDecoder().decode(svm.getAccount(holding).data).shares, 0n);
    assert.equal(finance(fm).totalShares, finance(fm).lockedShares);
    await send(await getWithdrawLpInstructionAsync({...lpAccounts, shares: 1n,
      minReceipt: 0n, ...quote(fm)}), true);
  });
