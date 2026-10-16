import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {
  ANTE_UP_PROGRAM_ADDRESS, FreeState, NaReason, decodeAnteUpEvent,
  getFreeOpenedEventEncoder, getFreeClosedEventEncoder,
  getFreeRecordEncoder, getFreeRecordDecoder,
  getAdmissionEncoder, getAdmissionDecoder,
  getOpenFreeInstructionAsync, findMarketPda,
} from '../../clients/chain/dist/index.js';
const requireChain = createRequire(new URL('../../clients/chain/package.json', import.meta.url));
const {generateKeyPairSigner} = requireChain('@solana/kit');

const address = ANTE_UP_PROGRAM_ADDRESS;
const hash = new Uint8Array(32).fill(7);
const point = {sequence: 1n, payloadHash: hash, executedAt: 1_800_000_000n,
  slot: 42n, hNum: 125n, hDen: 100n, usable: true, reason: NaReason.None};

test('old padded Admission PDA decodes new lifetime counters as zero',()=>{
  const encoded=getAdmissionEncoder().encode({admin:address,open:true,outstanding:0,
    recent:Array(100).fill(0n),fundedOpenCap:0n,fundedOpenCount:0n});
  const oldLength=8+32+1+2+100*8;
  assert.equal(encoded.length,oldLength+16);
  const oldAccount=new Uint8Array(8+1024);
  oldAccount.set(encoded.subarray(0,oldLength));
  const decoded=getAdmissionDecoder().decode(oldAccount);
  assert.equal(decoded.open,true);
  assert.equal(decoded.fundedOpenCap,0n);
  assert.equal(decoded.fundedOpenCount,0n);
});

test('compiled-IDL event bytes decode to historical open and terminal state', () => {
  const opened = decodeAnteUpEvent(getFreeOpenedEventEncoder().encode({
    record: address, recordId: 9n, owner: address, market: address, entry: point,
  }));
  assert.equal(opened.kind, 'freeOpened');
  assert.equal(opened.value.entry.slot, 42n);
  const closed = decodeAnteUpEvent(getFreeClosedEventEncoder().encode({
    record: address, recordId: 9n, owner: address, market: address,
    state: FreeState.ClosedResult, entry: point,
    exit: {...point, sequence: 2n, slot: 60n, hNum: 150n},
    resultNegative: false, resultNum: 25n, resultDen: 125n,
    naReason: NaReason.None,
  }));
  assert.equal(closed.kind, 'freeClosed');
  assert.equal(closed.value.resultNum, 25n);
  assert.equal(closed.value.exit.sequence, 2n);
  assert.throws(() => decodeAnteUpEvent(new Uint8Array(8)), /identified/);
});

test('generated current account codec is distinct from event state', () => {
  const data = getFreeRecordEncoder().encode({
    id: 9n, owner: address, market: address, state: FreeState.ClosedResult,
    openedAt: point.executedAt, closedAt: point.executedAt + 10n,
    entry: point, exit: {...point, slot: 60n}, resultNegative: false,
    resultNum: 0n, resultDen: 1n, naReason: NaReason.None,
    proofComplete: false, proofHash: new Uint8Array(32),
  });
  const current = getFreeRecordDecoder().decode(data);
  assert.equal(current.id, 9n);
  assert.equal(current.exit.slot, 60n);
});

test('generated instruction resolves PDA and encodes wallet-signed open', async () => {
  const owner = await generateKeyPairSigner();
  const marketId = new Uint8Array(32).fill(1);
  const [market] = await findMarketPda({marketId});
  const ix = await getOpenFreeInstructionAsync({market, owner, recordId: 9n});
  assert.equal(ix.programAddress, address);
  assert.ok(ix.data.length >= 16);
  assert.equal(ix.accounts.length, 7);
});
