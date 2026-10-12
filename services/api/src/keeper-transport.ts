import {readFile} from 'node:fs/promises';
import {address, createKeyPairSignerFromBytes, getSignatureFromTransaction,
  type Instruction, type KeyPairSigner} from '@solana/kit';
import {createKitChainTransport, prepareUnsignedTransaction, submitAndConfirmFinalized, withKitSigner,
  type ChainTransport} from '../../../clients/chain/dist/runtime.js';
import type {KeeperInstructionTransport} from './keeper-chain.ts';

/** Loads a conventional Solana 64-byte JSON keypair only in explicit execution mode. */
export async function loadKeeperKeypair(path:string):Promise<KeyPairSigner> {
  const value:unknown=JSON.parse(await readFile(path,'utf8'));
  if (!Array.isArray(value) || value.length!==64 || value.some(byte=>!Number.isInteger(byte) || byte<0 || byte>255))
    throw new Error('KEEPER_KEYPAIR_INVALID');
  return createKeyPairSignerFromBytes(Uint8Array.from(value));
}

/** One generated instruction, one authority signature, one submission. Finality is reconciled on the next run. */
export class KitKeeperInstructionTransport implements KeeperInstructionTransport {
  readonly publisherAddress:string;
  readonly keeperAddress:string;
  readonly programId:string;
  readonly rpc:ChainTransport;
  private readonly publisher:KeyPairSigner;
  private readonly keeper:KeyPairSigner;
  constructor(input:{endpoint:string;programId:string;publisher:KeyPairSigner;keeper:KeyPairSigner;rpc?:ChainTransport}) {
    this.publisher=input.publisher;this.keeper=input.keeper;
    this.publisherAddress=String(input.publisher.address);this.keeperAddress=String(input.keeper.address);
    this.programId=String(address(input.programId));this.rpc=input.rpc??createKitChainTransport(input.endpoint);
  }
  async send(instruction:Instruction,authority:'publisher'|'keeper',onSigned?:(signature:string)=>void):Promise<string> {
    if (String(instruction.programAddress)!==this.programId) throw new Error('KEEPER_PROGRAM_MISMATCH');
    const signer=authority==='publisher'?this.publisher:this.keeper;
    const prepared=await prepareUnsignedTransaction({transport:this.rpc,instruction,feePayer:signer.address,
      programAddress:address(this.programId)});
    const sign=withKitSigner(signer);
    const outcome=await submitAndConfirmFinalized({transport:this.rpc,prepared,expectedInstruction:instruction,
      sign:async unsigned=>{const signed=await sign(unsigned);onSigned?.(getSignatureFromTransaction(signed));return signed;}});
    if (!outcome.signature) throw new Error('KEEPER_SUBMISSION_UNCERTAIN_NO_SIGNATURE');
    return outcome.signature;
  }
  async signatureStatus(signature:string):Promise<'FINALIZED'|'FAILED'|'PENDING'> {
    const status=await this.rpc.getSignatureStatus(signature);
    if (status?.err!=null) return 'FAILED';
    return status?.confirmationStatus==='finalized'?'FINALIZED':'PENDING';
  }
}
