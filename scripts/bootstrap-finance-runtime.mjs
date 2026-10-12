import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import * as chain from '../clients/chain/dist/index.js';

const requireChain=createRequire(new URL('../clients/chain/package.json',import.meta.url));
const kit=requireChain('@solana/kit');
const spl=requireChain('@solana-program/token');
const system=requireChain('@solana-program/system');
const fail=(condition,code)=>{if(!condition)throw new Error(code);};
const optionalAddress=value=>value==null?null:kit.unwrapOption(value);

async function signerFromFile(path) {
  fail(path,'BOOTSTRAP_KEYPAIR_FILE_REQUIRED');
  const bytes=JSON.parse(await readFile(path,'utf8'));
  fail(Array.isArray(bytes) && bytes.length===64 && bytes.every(x=>Number.isInteger(x)&&x>=0&&x<256),
    'INVALID_BOOTSTRAP_KEYPAIR');
  return kit.createKeyPairSignerFromBytes(Uint8Array.from(bytes));
}

export async function buildFinanceStepInstructions(step,{plan,config,adminSigner,mintSigner,rpc}) {
  fail(adminSigner?.address===config.admin && mintSigner?.address===config.paymentMint,
    'BOOTSTRAP_SIGNER_MISMATCH');
  switch(step.kind){
    case 'CREATE_MINT': {
      const rent=await rpc.getMinimumBalanceForRentExemption(BigInt(spl.getMintSize()),
        {commitment:'finalized'}).send();
      return [system.getCreateAccountInstruction({payer:adminSigner,newAccount:mintSigner,
        lamports:rent,space:BigInt(spl.getMintSize()),programAddress:spl.TOKEN_PROGRAM_ADDRESS}),
        spl.getInitializeMint2Instruction({mint:config.paymentMint,decimals:6,
          mintAuthority:config.admin,freezeAuthority:null})];
    }
    case 'CREATE_TREASURY_ATA':
      return [spl.getCreateAssociatedTokenIdempotentInstruction({payer:adminSigner,
        ata:plan.treasuryAta,owner:config.admin,mint:config.paymentMint,
        tokenProgram:spl.TOKEN_PROGRAM_ADDRESS})];
    case 'MINT_SUPPORT':
      return [spl.getMintToCheckedInstruction({mint:config.paymentMint,token:plan.treasuryAta,
        mintAuthority:adminSigner,amount:BigInt(step.amountAtoms),decimals:6})];
    case 'TRANSFER_MINT_AUTHORITY':
      return [spl.getSetAuthorityInstruction({owned:config.paymentMint,owner:adminSigner,
        authorityType:spl.AuthorityType.MintTokens,newAuthority:plan.financeConfig})];
    case 'INITIALIZE_FINANCE':
      return [await chain.getInitializeFinanceInstructionAsync({paymentMint:config.paymentMint,
        protocolTreasury:plan.treasuryAta,admin:adminSigner,
        faucetAmount:BigInt(config.faucetAmountAtoms),
        faucetCooldown:BigInt(config.faucetCooldownSeconds),
        faucetTotalLimit:BigInt(config.faucetGlobalCapAtoms)},
      {programAddress:config.programId})];
    default: throw new Error('UNKNOWN_BOOTSTRAP_STEP');
  }
}

export function createFinanceBootstrapRuntime({config,rpc,transport,adminSigner,mintSigner,
  expectedGenesisHash,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  fail(['localnet','devnet'].includes(config.cluster),'CLUSTER_MUST_BE_TESTNET');
  fail(adminSigner?.address===config.admin && mintSigner?.address===config.paymentMint,
    'BOOTSTRAP_SIGNER_MISMATCH');
  fail(expectedGenesisHash && kit.isAddress(expectedGenesisHash),'EXPECTED_GENESIS_HASH_REQUIRED');
  fail(rpc && transport,'BOOTSTRAP_RPC_REQUIRED');
  let genesisChecked=false;
  async function checkGenesis(){
    if(genesisChecked)return;
    fail((await rpc.getGenesisHash().send())===expectedGenesisHash,'BOOTSTRAP_GENESIS_MISMATCH');
    genesisChecked=true;
  }
  async function account(address){return transport.getFinalizedAccount(address);}
  async function optional(address){const value=await account(address);return value.exists?value:null;}
  async function readFinalizedState(plan){
    await checkGenesis();
    const program=await account(config.programId);
    const core=await account(plan.configPda);
    const mint=await optional(config.paymentMint);
    const treasury=await optional(plan.treasuryAta);
    const finance=await optional(plan.financeConfig);
    const coreData=core.exists && core.programAddress===config.programId
      ? chain.decodeConfig(core).data:null;
    const mintData=mint && mint.programAddress===spl.TOKEN_PROGRAM_ADDRESS
      ? spl.decodeMint(mint).data:null;
    const tokenData=treasury && treasury.programAddress===spl.TOKEN_PROGRAM_ADDRESS
      ? spl.decodeToken(treasury).data:null;
    const financeData=finance && finance.programAddress===config.programId
      ? chain.decodeFinanceConfig(finance).data:null;
    return {
      program:{address:config.programId,executable:program.exists && program.executable,
        finality:'finalized'},
      coreConfig:coreData && {address:plan.configPda,ownerProgramId:core.programAddress,
        admin:coreData.admin,finality:'finalized'},
      mint:mint && {address:config.paymentMint,ownerProgramId:mint.programAddress,
        decimals:mintData?.decimals,isInitialized:mintData?.isInitialized,
        mintAuthority:optionalAddress(mintData?.mintAuthority),
        freezeAuthority:optionalAddress(mintData?.freezeAuthority),
        supplyAtoms:mintData?.supply.toString(),finality:'finalized'},
      treasury:treasury && {address:plan.treasuryAta,ownerProgramId:treasury.programAddress,
        mint:tokenData?.mint,owner:tokenData?.owner,state:tokenData?.state,
        delegate:optionalAddress(tokenData?.delegate),
        closeAuthority:optionalAddress(tokenData?.closeAuthority),
        amountAtoms:tokenData?.amount.toString(),finality:'finalized'},
      financeConfig:finance && {address:plan.financeConfig,ownerProgramId:finance.programAddress,
        admin:financeData?.admin,paymentMint:financeData?.paymentMint,
        protocolTreasury:financeData?.protocolTreasury,
        faucetAmountAtoms:financeData?.faucetAmount.toString(),
        faucetCooldownSeconds:financeData?.faucetCooldown.toString(),
        faucetGlobalCapAtoms:financeData?.faucetTotalLimit.toString(),
        faucetMintedAtoms:financeData?.faucetMinted.toString(),finality:'finalized'},
    };
  }
  async function executeStep(step,{plan,onSigned}){
    await checkGenesis();
    const instructions=await buildFinanceStepInstructions(step,
      {plan,config,adminSigner,mintSigner,rpc});
    const lifetime=await transport.getLatestBlockhash();
    fail(await transport.getBlockHeight()<=lifetime.lastValidBlockHeight,
      'BOOTSTRAP_BLOCKHASH_EXPIRED');
    fail(await transport.isBlockhashValid(lifetime.blockhash),'BOOTSTRAP_BLOCKHASH_INVALID');
    const message=kit.appendTransactionMessageInstructions(instructions,
      kit.setTransactionMessageLifetimeUsingBlockhash({blockhash:kit.blockhash(lifetime.blockhash),
        lastValidBlockHeight:lifetime.lastValidBlockHeight},
      kit.setTransactionMessageFeePayer(config.admin,kit.createTransactionMessage({version:0}))));
    const unsigned=kit.compileTransaction(message);
    const signers=step.kind==='CREATE_MINT'?[adminSigner,mintSigner]:[adminSigner];
    const signed=await kit.signTransactionWithSigners(signers,unsigned);
    fail(kit.isFullySignedTransaction(signed),'BOOTSTRAP_SIGNATURE_INCOMPLETE');
    const signature=kit.getSignatureFromTransaction(signed);
    await onSigned(signature); // Persist the signature before any uncertain send.
    const wire=kit.getBase64Decoder().decode(kit.getTransactionEncoder().encode(signed));
    let returned;
    try{returned=await transport.sendTransaction(wire);}catch{return {signature,state:'UNKNOWN'};}
    if(returned!==signature)return {signature,state:'UNKNOWN'};
    for(let attempt=0;attempt<8;attempt++){
      const status=await transport.getSignatureStatus(signature).catch(()=>null);
      if(status?.err!=null)return {signature,state:'FAILED'};
      if(status?.confirmationStatus==='finalized')return {signature,state:'FINALIZED'};
      if(await transport.getBlockHeight()>lifetime.lastValidBlockHeight)
        return {signature,state:'UNKNOWN'};
      if(attempt<7)await wait(400);
    }
    return {signature,state:'UNKNOWN'};
  }
  async function reconcilePending(pending){
    await checkGenesis();
    const status=await transport.getSignatureStatus(pending.signature).catch(()=>null);
    return status?.err!=null?'FAILED':status?.confirmationStatus==='finalized'?'FINALIZED':'UNKNOWN';
  }
  return {expectedGenesisHash,readFinalizedState,executeStep,reconcilePending};
}

export async function createFinanceBootstrapRuntimeFromEnv(config,env=process.env){
  const endpoint=env.ANTE_UP_BOOTSTRAP_RPC_URL;
  fail(endpoint,'BOOTSTRAP_RPC_URL_REQUIRED');
  const url=new URL(endpoint);
  fail(['http:','https:'].includes(url.protocol),'BOOTSTRAP_RPC_URL_INVALID');
  if(config.cluster==='localnet')
    fail(['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname),'LOCALNET_RPC_MUST_BE_LOOPBACK');
  const [adminSigner,mintSigner]=await Promise.all([
    signerFromFile(env.ANTE_UP_BOOTSTRAP_ADMIN_KEYPAIR_FILE),
    signerFromFile(env.ANTE_UP_BOOTSTRAP_MINT_KEYPAIR_FILE)]);
  return createFinanceBootstrapRuntime({config,
    rpc:kit.createSolanaRpc(endpoint),transport:chain.createKitChainTransport(endpoint),
    adminSigner,mintSigner,
    expectedGenesisHash:env.ANTE_UP_BOOTSTRAP_EXPECTED_GENESIS_HASH});
}
