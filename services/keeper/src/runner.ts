export interface KeeperPassResult {state:string;action?:string|null;signature?:string|null}
export interface KeeperRunnerOptions {
  intervalMs:number;maxPasses:number;maxConsecutiveErrors:number;
  signal?:AbortSignal;pass:()=>Promise<KeeperPassResult>;
  report:(event:{pass:number;result?:KeeperPassResult;error?:string})=>void;
  sleep?:(ms:number,signal?:AbortSignal)=>Promise<void>;
}

const defaultSleep=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{
  if (signal?.aborted) return reject(new Error('KEEPER_STOPPED'));
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},ms);
  const onAbort=()=>{clearTimeout(timer);reject(new Error('KEEPER_STOPPED'));};
  signal?.addEventListener('abort',onAbort,{once:true});
});

/** No overlapping passes; each pass may send at most one transaction. Errors back off and eventually stop. */
export async function runKeeperLoop(options:KeeperRunnerOptions):Promise<{passes:number;errors:number}> {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs<1000 || options.intervalMs>300_000 ||
      !Number.isSafeInteger(options.maxPasses) || options.maxPasses<1 ||
      !Number.isSafeInteger(options.maxConsecutiveErrors) || options.maxConsecutiveErrors<1)
    throw new Error('KEEPER_RUNNER_OPTIONS_INVALID');
  let passes=0,consecutiveErrors=0;
  while (passes<options.maxPasses && !options.signal?.aborted) {
    passes++;
    try {
      const result=await options.pass();
      consecutiveErrors=0;options.report({pass:passes,result});
    } catch(error) {
      consecutiveErrors++;
      options.report({pass:passes,error:error instanceof Error?error.message:String(error)});
      if (consecutiveErrors>=options.maxConsecutiveErrors) throw new Error('KEEPER_RETRY_LIMIT_REACHED');
    }
    if (passes<options.maxPasses && !options.signal?.aborted) {
      const delay=Math.min(options.intervalMs*2**Math.max(0,consecutiveErrors-1),300_000);
      try {await (options.sleep??defaultSleep)(delay,options.signal);} catch(error) {
        if (!options.signal?.aborted) throw error;
      }
    }
  }
  return {passes,errors:consecutiveErrors};
}
