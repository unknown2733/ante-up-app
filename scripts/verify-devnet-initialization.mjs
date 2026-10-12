import {createRequire} from 'node:module';
import * as chain from '../clients/chain/dist/index.js';
const requireChain=createRequire(new URL('../clients/chain/package.json',import.meta.url));
const kit=requireChain('@solana/kit'),spl=requireChain('@solana-program/token');
const check=(ok,code)=>{if(!ok)throw new Error(code);};
async function main(){
  const endpoint=process.env.ANTE_UP_RPC_URL??'https://api.devnet.solana.com';
  const rpc=kit.createSolanaRpc(endpoint),transport=chain.createKitChainTransport(endpoint);
  check(await rpc.getGenesisHash().send()==='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG','DEVNET_REQUIRED');
  const core=await chain.readFinalizedConfig(transport),gate=await chain.readFinalizedAdmission(transport),
    finance=await chain.readFinalizedFinanceConfig(transport);
  const mintRaw=await transport.getFinalizedAccount(finance.data.paymentMint),
    treasuryRaw=await transport.getFinalizedAccount(finance.data.protocolTreasury);
  check(mintRaw.exists && mintRaw.programAddress===spl.TOKEN_PROGRAM_ADDRESS,'PAYMENT_MINT_OWNER');
  check(treasuryRaw.exists && treasuryRaw.programAddress===spl.TOKEN_PROGRAM_ADDRESS,'TREASURY_OWNER');
  const mint=spl.decodeMint(mintRaw).data,treasury=spl.decodeToken(treasuryRaw).data;
  const authority=kit.unwrapOption(mint.mintAuthority),freeze=kit.unwrapOption(mint.freezeAuthority);
  check(core.data.admin===finance.data.admin && gate.data.admin===core.data.admin,'ADMIN_MISMATCH');
  check(authority===finance.address && freeze===null && mint.decimals===6,'MINT_AUTHORITY_MISMATCH');
  check(treasury.mint===finance.data.paymentMint && treasury.owner===finance.data.admin,'TREASURY_MISMATCH');
  check(mint.supply===50_000_000_000n && treasury.amount===50_000_000_000n &&
    finance.data.faucetMinted===0n,'INITIAL_SUPPLY_MISMATCH');
  check(!gate.data.open,'ADMISSION_MUST_REMAIN_CLOSED');
  process.stdout.write(JSON.stringify({state:'VERIFIED_FINALIZED',programId:chain.ANTE_UP_PROGRAM_ADDRESS,
    config:core.address,admission:gate.address,financeConfig:finance.address,
    admin:core.data.admin,publisher:core.data.publisher,proofAuthority:core.data.proofAuthority,
    paymentMint:finance.data.paymentMint,treasury:finance.data.protocolTreasury,
    mintAuthority:authority,freezeAuthority:freeze,decimals:mint.decimals,
    supplyAtoms:mint.supply.toString(),treasuryAtoms:treasury.amount.toString(),
    faucetAmountAtoms:finance.data.faucetAmount.toString(),faucetCooldownSeconds:finance.data.faucetCooldown.toString(),
    faucetGlobalCapAtoms:finance.data.faucetTotalLimit.toString(),faucetMintedAtoms:finance.data.faucetMinted.toString(),
    admissionOpen:gate.data.open})+'\n');
}
main().catch(e=>{process.stderr.write(`${e.message}\n`);process.exitCode=1;});
