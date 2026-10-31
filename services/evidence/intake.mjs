const check=(ok,code)=>{if(!ok)throw Error(code);};
const integer=value=>{
 check(typeof value==='string'&&/^\d+$/.test(value),'EVIDENCE_BUDGET_INVALID');
 return BigInt(value);
};

// Every finalized close is an accepted obligation, even when the upload
// budget is exhausted. Intake is a durable inventory, not a spending permit.
export function reconcileIntake(records,jobs,previous={version:1,obligations:{}},now=Math.floor(Date.now()/1000)){
 check(previous?.version===1&&previous.obligations&&typeof previous.obligations==='object','EVIDENCE_INTAKE_INVALID');
 const obligations={...previous.obligations};
 for(const record of records){
  if(record.finality!=='finalized'||!['CLOSED_RESULT','CLOSED_NA'].includes(record.status)||!record.exit)continue;
  const job=jobs[`proof:${record.id}:original`];
  const old=obligations[record.id];
  obligations[record.id]={firstSeenAt:old?.firstSeenAt??now,
   state:record.proofId?'LINKED':job?.state==='ISSUED'?'ISSUED_AWAITING_LINK':job?'PROCESSING':'WAITING',
   proofId:record.proofId??null};
 }
 return {version:1,obligations};
}

// Conservative capacity for one additional chip. The on-chain outstanding
// count includes open records and closed records still awaiting proofComplete.
// Existing obligations may consume the remaining budget; they are never erased.
export function admissionBudget({ledger,totalLimit,dailyLimit,perRecordLimit,balanceWinc,outstanding,now=Date.now()}){
 check(Number.isSafeInteger(outstanding)&&outstanding>=0&&outstanding<=200,'EVIDENCE_OUTSTANDING_INVALID');
 const totalCap=integer(String(totalLimit)),dailyCap=integer(String(dailyLimit)),perRecord=integer(String(perRecordLimit));
 check(totalCap>0n&&dailyCap>0n&&perRecord>0n,'EVIDENCE_BUDGET_INVALID');
 check(ledger?.version===1&&ledger.reservations&&typeof ledger.reservations==='object','EVIDENCE_BUDGET_INVALID');
 const day=new Date(now).toISOString().slice(0,10);
 let total=0n,today=0n;
 for(const [key,value] of Object.entries(ledger.reservations)){
  check(/^[a-f0-9]{64}$/.test(key)&&value&&typeof value==='object','EVIDENCE_BUDGET_INVALID');
  const amount=integer(value.winc);total+=amount;
  const byDay=value.byDay?.[day]??(value.day===day?value.winc:'0');
  today+=integer(byDay);
 }
 // One new record needs headroom after conservatively covering accepted duty.
 const liability=BigInt(outstanding+1)*perRecord;
 const reason=total+liability>totalCap?'TOTAL_BUDGET':today+liability>dailyCap?'DAILY_BUDGET':
  balanceWinc!==undefined&&integer(String(balanceWinc))<liability?'TURBO_BALANCE':null;
 return {admit:reason===null,reason,day,totalReservedWinc:total.toString(),dailyReservedWinc:today.toString(),
  acceptedObligationReserveWinc:(BigInt(outstanding)*perRecord).toString(),nextRecordReserveWinc:perRecord.toString()};
}

// Reserve the full unused on-chain cap, not just the next request. The count
// never decreases when a chip closes, so this upper-bounds all future opens
// until the operator deliberately raises the cap again.
export function fundedCapBudget({fundedOpenCount,cap,outstanding,...budget}){
 check(Number.isSafeInteger(fundedOpenCount)&&fundedOpenCount>=0,'EVIDENCE_CAP_INVALID');
 check(Number.isSafeInteger(cap)&&cap>fundedOpenCount,'EVIDENCE_CAP_INVALID');
 const remaining=cap-fundedOpenCount;
 check(Number.isSafeInteger(outstanding)&&outstanding>=0&&outstanding+remaining<=200,'EVIDENCE_CAP_INVALID');
 return {...admissionBudget({...budget,outstanding:outstanding+remaining-1}),
  reservedFutureOpens:remaining};
}

/** Read-only accounting for every remaining funded admission and open proof duty. */
export function proofCapacitySnapshot({gate,balanceWinc,perRecordLimitWinc,now=Math.floor(Date.now()/1000)}){
 const cap=BigInt(gate.fundedOpenCap),used=BigInt(gate.fundedOpenCount);
 const outstanding=BigInt(gate.outstanding),perRecord=integer(String(perRecordLimitWinc));
 const balance=integer(String(balanceWinc));
 check(cap>=used&&outstanding>=0n&&perRecord>0n&&
  Number.isSafeInteger(now)&&now>0,'EVIDENCE_CAP_INVALID');
 const remaining=cap-used,required=(remaining+outstanding)*perRecord;
 return {version:1,observedAt:now,fundedCap:cap.toString(),fundedUsed:used.toString(),
  fundedRemaining:remaining.toString(),outstanding:outstanding.toString(),
  perRecordLimitWinc:perRecord.toString(),turboBalanceWinc:balance.toString(),
  requiredWinc:required.toString(),fullyCovered:balance>=required};
}
