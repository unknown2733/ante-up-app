import { address, createSolanaRpc } from '@solana/kit';

export const CLOCK_ADDRESS='SysvarC1ock11111111111111111111111111111111';
const SYSVAR_OWNER='Sysvar1111111111111111111111111111111111111';
export interface FinancialClockSample {unixTimestamp:number;observedAt:number}
export type FinancialClock=()=>Promise<FinancialClockSample>;

/** Contract allows at most Clock + 30 seconds; retain one second of headroom. */
export function financialQuoteDeadline(quotedAt:number,now:number,sample:FinancialClockSample):number {
  if (![quotedAt,now,sample.unixTimestamp,sample.observedAt].every(n=>Number.isSafeInteger(n)&&n>=0) ||
      quotedAt>now || sample.observedAt>now || now-sample.observedAt>5 ||
      Math.abs(now-sample.unixTimestamp)>10) throw new Error('REQUOTE_REQUIRED');
  const deadline=Math.min(quotedAt+30,sample.unixTimestamp+29);
  if (!Number.isSafeInteger(deadline) || deadline<=now) throw new Error('REQUOTE_REQUIRED');
  return deadline;
}

/** Clock freshness only uses confirmed commitment. Financial account validation remains finalized. */
export class KitConfirmedFinancialClock {
  private readonly rpc:ReturnType<typeof createSolanaRpc>;
  private readonly now:()=>number;
  private readonly monotonic:()=>number;
  constructor(endpoint:string,options:{rpc?:ReturnType<typeof createSolanaRpc>;now?:()=>number;monotonic?:()=>number}={}) {
    this.rpc=options.rpc??createSolanaRpc(endpoint);
    this.now=options.now??(()=>Math.floor(Date.now()/1000));
    this.monotonic=options.monotonic??(()=>performance.now());
  }
  async read():Promise<FinancialClockSample> {
    try {
      const started=this.monotonic();
      const abortSignal=AbortSignal.timeout(5000);
      const slot=await this.rpc.getSlot({commitment:'confirmed'}).send({abortSignal});
      const response=await this.rpc.getAccountInfo(address(CLOCK_ADDRESS),{commitment:'confirmed',encoding:'base64',minContextSlot:slot}).send({abortSignal});
      const elapsed=this.monotonic()-started;
      const value=response.value;
      if (elapsed<0 || elapsed>5000 || abortSignal.aborted || !value || String(value.owner)!==SYSVAR_OWNER ||
          value.executable || response.context.slot<slot || !Array.isArray(value.data) || value.data[1]!=='base64') throw new Error();
      const bytes=Buffer.from(value.data[0],'base64');
      if (bytes.length!==40 || bytes.readBigUInt64LE(0)>response.context.slot) throw new Error();
      const sample={unixTimestamp:Number(bytes.readBigInt64LE(32)),observedAt:this.now()};
      financialQuoteDeadline(sample.observedAt,sample.observedAt,sample);
      return sample;
    } catch {throw new Error('REQUOTE_REQUIRED');}
  }
}
