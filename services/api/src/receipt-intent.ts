import {getCompiledTransactionMessageDecoder} from '@solana/kit';

const COMPUTE='ComputeBudget111111111111111111111111111111';
function reject(): never {throw new Error('TRANSACTION_INTENT_MISMATCH');}

/** Wallets may add transaction-wide bounded compute settings without changing intent. */
export function verifyMessageIntent(expectedBytes: Uint8Array, actualBytes: Uint8Array): void {
  if(Buffer.from(expectedBytes).equals(Buffer.from(actualBytes))) return;
  const decoder=getCompiledTransactionMessageDecoder();
  const expected=decoder.decode(expectedBytes),actual=decoder.decode(actualBytes);
  if((expected.version!==0 && expected.version!=='legacy') || (actual.version!==0 && actual.version!=='legacy')) reject();
  if(expected.version!==actual.version || expected.lifetimeToken!==actual.lifetimeToken ||
    expected.staticAccounts[0]!==actual.staticAccounts[0] ||
    ('addressTableLookups' in expected && expected.addressTableLookups?.length) ||
    ('addressTableLookups' in actual && actual.addressTableLookups?.length)) reject();
  const role=(m:typeof expected,i:number)=>({
    signer:i<m.header.numSignerAccounts,
    writable:i<m.header.numSignerAccounts?i<m.header.numSignerAccounts-m.header.numReadonlySignerAccounts:
      i<m.staticAccounts.length-m.header.numReadonlyNonSignerAccounts,
  });
  if(new Set(expected.staticAccounts).size!==expected.staticAccounts.length ||
    new Set(actual.staticAccounts).size!==actual.staticAccounts.length || expected.staticAccounts.includes(COMPUTE as never)) reject();
  if(actual.staticAccounts.length!==expected.staticAccounts.length+1) reject();
  for(let i=0;i<expected.staticAccounts.length;i++){
    const j=actual.staticAccounts.indexOf(expected.staticAccounts[i]);
    if(j<0 || JSON.stringify(role(expected,i))!==JSON.stringify(role(actual,j))) reject();
  }
  const ci=actual.staticAccounts.indexOf(COMPUTE as never);
  if(ci<0 || role(actual,ci).signer || role(actual,ci).writable) reject();
  let units=1_400_000n,price=0n;
  const seen=new Set<number>(),instructions=[];
  for(const ix of actual.instructions){
    if(actual.staticAccounts[ix.programAddressIndex]!==COMPUTE){instructions.push(ix);continue;}
    if((ix.accountIndices?.length??0)!==0) reject();
    const data=Buffer.from(ix.data??[]),tag=data[0];
    if(seen.has(tag)) reject();seen.add(tag);
    if(tag===2 && data.length===5){units=BigInt(data.readUInt32LE(1));if(units===0n||units>1_400_000n)reject();}
    else if(tag===3 && data.length===9)price=data.readBigUInt64LE(1);
    else reject();
  }
  // At most 0.001 SOL of added priority fee; fee is paid by the signing wallet.
  if(seen.size===0 || (units*price+999_999n)/1_000_000n>1_000_000n) reject();
  const normalize=(m:typeof expected,ix:typeof expected.instructions[number])=>({
    program:m.staticAccounts[ix.programAddressIndex],
    accounts:(ix.accountIndices??[]).map(i=>m.staticAccounts[i]),data:Buffer.from(ix.data??[]).toString('hex'),
  });
  if(JSON.stringify(expected.instructions.map(ix=>normalize(expected,ix)))!==
     JSON.stringify(instructions.map(ix=>normalize(actual,ix)))) reject();
}
