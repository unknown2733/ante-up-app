import {setTimeout as sleep} from 'node:timers/promises';
const check=(ok,code)=>{if(!ok)throw Error(code);};

// Height is bound to a specific finalized block. Account readback must use this
// slot, not the earlier post-stop boundary, as its minimum context.
export async function readFinalizedExpiry(rpc,boundary){
 const slot=await rpc('getSlot',[{commitment:'finalized',minContextSlot:boundary.slot}]);
 check(Number.isSafeInteger(slot)&&slot>0,'RECOVERY_FINALITY_CONTEXT_INVALID');
 if(slot<boundary.slot)return {slot,height:'0',blockhashValid:true};
 const block=await rpc('getBlock',[slot,{commitment:'finalized',transactionDetails:'none',rewards:false}]);
 check(Number.isSafeInteger(block?.blockHeight)&&block.blockHeight>=0,'RECOVERY_EXPIRY_BLOCK_UNAVAILABLE');
 const valid=await rpc('isBlockhashValid',[boundary.blockhash,{commitment:'finalized',minContextSlot:slot}]);
 check(Number.isSafeInteger(valid?.context?.slot)&&valid.context.slot>=slot&&typeof valid.value==='boolean','RECOVERY_FINALITY_CONTEXT_INVALID');
 return {slot,height:String(block.blockHeight),blockhashValid:valid.value};
}

export function rpcReader(endpoints,{fetcher=fetch,wait=sleep}={}){return async(method,params=[])=>{
  check(['getGenesisHash','getLatestBlockhash','getBlockTime','getBlock','getSlot','getBlockHeight','isBlockhashValid',
    'getMultipleAccounts','getAccountInfo','getSignatureStatuses'].includes(method),'RECOVERY_RPC_METHOD_NOT_READ_ONLY');
  const blocked=new Set(),errors=new Map();let pendingBlockTime=false;
  for(let pass=0;pass<3;pass++){
    let retryable=false;
    for(const endpoint of endpoints){
      if(blocked.has(endpoint))continue;
      try{
        const r=await fetcher(endpoint,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(12000),redirect:'error'});
        if(!r.ok){
          await r.body?.cancel();const transient=r.status===429||r.status>=500&&r.status<=599;
          errors.set(endpoint,r.status===429?'RECOVERY_RPC_RATE_LIMITED':transient?'RECOVERY_RPC_UNAVAILABLE':'RECOVERY_RPC_REJECTED');
          if(transient)retryable=true;else blocked.add(endpoint);continue;
        }
        let d;try{d=await r.json();}catch{errors.set(endpoint,'RECOVERY_RPC_INVALID_RESPONSE');blocked.add(endpoint);continue;}
        if(!d.error&&d.result!==undefined)return d.result;
        if(method==='getBlockTime'&&[-32004,-32007,-32009].includes(d.error?.code)){pendingBlockTime=true;blocked.add(endpoint);continue;}
        if(d.error?.code===-32016){errors.set(endpoint,'RECOVERY_RPC_CONTEXT_NOT_READY');retryable=true;continue;}
        errors.set(endpoint,'RECOVERY_RPC_REJECTED');blocked.add(endpoint);
      }catch(e){
        // Only transport failures/timeouts are retried. No provider response text
        // or token-bearing URL is retained in diagnostics.
        if(e?.name==='TimeoutError'||e?.name==='AbortError'||e instanceof TypeError){errors.set(endpoint,'RECOVERY_RPC_UNAVAILABLE');retryable=true;}
        else{errors.set(endpoint,'RECOVERY_RPC_UNAVAILABLE');blocked.add(endpoint);}
      }
    }
    if(!retryable||pass===2)break;
    await wait(pass===0?500:1000);
  }
  if(pendingBlockTime)return null;
  const codes=[...errors.values()];
  throw Error(codes.includes('RECOVERY_RPC_CONTEXT_NOT_READY')?'RECOVERY_RPC_CONTEXT_NOT_READY':
    codes.includes('RECOVERY_RPC_RATE_LIMITED')?'RECOVERY_RPC_RATE_LIMITED':
    codes.includes('RECOVERY_RPC_UNAVAILABLE')?'RECOVERY_RPC_UNAVAILABLE':codes[0]??'RECOVERY_RPC_UNAVAILABLE');
};}
