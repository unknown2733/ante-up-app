/** Derive evidence intervals from cumulative readings without fabricating minute counts. */
export function deriveCumulativeIntervals(readings,{bucketMs=300_000}={}){
  if(!Array.isArray(readings)||!Number.isSafeInteger(bucketMs)||bucketMs<=0)
    throw Error('CUMULATIVE_INTERVAL_ARGS_INVALID');
  const byBucket=new Map();
  for(const row of readings){
    if(!row||!Number.isSafeInteger(row.observedAtMs)||row.observedAtMs<0||
        !Number.isSafeInteger(row.capturedAtMs)||row.capturedAtMs<row.observedAtMs||
        typeof row.value!=='string'||!/^(0|[1-9][0-9]*)$/.test(row.value))
      throw Error('CUMULATIVE_READING_INVALID');
    const bucket=Math.floor(row.observedAtMs/bucketMs)*bucketMs;
    const previous=byBucket.get(bucket);
    if(!previous||row.observedAtMs>previous.observedAtMs||
        row.observedAtMs===previous.observedAtMs&&row.capturedAtMs>previous.capturedAtMs)
      byBucket.set(bucket,{...row,bucket});
  }
  const selected=[...byBucket.values()].sort((a,b)=>a.bucket-b.bucket);
  const intervals=[];
  // After a provider lowers a cumulative counter, later positive differences
  // may merely undo the correction. Do not label them as new activity until
  // a reading has crossed the last known pre-correction value.
  let revisionBaseline=null;
  for(let i=1;i<selected.length;i++){
    const from=selected[i-1],to=selected[i];
    const base={fromAtMs:from.observedAtMs,toAtMs:to.observedAtMs,
      durationMs:to.observedAtMs-from.observedAtMs,
      fromRawSha256:from.rawSha256??null,toRawSha256:to.rawSha256??null};
    const change=BigInt(to.value)-BigInt(from.value);
    if(change<0n){
      const prior=BigInt(from.value);
      if(revisionBaseline===null||prior>revisionBaseline)revisionBaseline=prior;
    }
    if(to.bucket-from.bucket!==bucketMs){
      intervals.push({...base,kind:'GAP',deltaCount:null});
      if(revisionBaseline!==null&&BigInt(to.value)>revisionBaseline)revisionBaseline=null;
      continue;
    }
    if(change<0n){
      intervals.push({...base,kind:'DOWNWARD_REVISION',deltaCount:null,
        revisionMagnitude:(-change).toString()});continue;
    }
    if(revisionBaseline!==null){
      intervals.push({...base,kind:'REVISION_RECOVERY',deltaCount:null,
        revisionBaselineCount:revisionBaseline.toString()});
      if(BigInt(to.value)>revisionBaseline)revisionBaseline=null;
      continue;
    }
    intervals.push({...base,kind:'OBSERVED_DELTA',deltaCount:change.toString()});
  }
  return {selectedReadings:selected.length,intervals};
}
