/** Derive evidence intervals from cumulative readings without fabricating minute counts. */
export function deriveCumulativeIntervals(readings,{bucketMs=300_000}={}){
  if(!Array.isArray(readings)||!Number.isSafeInteger(bucketMs)||bucketMs<=0)
    throw Error('CUMULATIVE_INTERVAL_ARGS_INVALID');
  const byTime=new Map();
  for(const row of readings){
    if(!row||!Number.isSafeInteger(row.observedAtMs)||row.observedAtMs<0||
        !Number.isSafeInteger(row.capturedAtMs)||row.capturedAtMs<row.observedAtMs||
        typeof row.value!=='string'||!/^(0|[1-9][0-9]*)$/.test(row.value))
      throw Error('CUMULATIVE_READING_INVALID');
    const previous=byTime.get(row.observedAtMs);
    if(!previous||row.capturedAtMs>previous.capturedAtMs||
        row.capturedAtMs===previous.capturedAtMs&&(row.rawSha256??'')>(previous.rawSha256??''))
      byTime.set(row.observedAtMs,row);
  }
  const byBucket=new Map();
  for(const row of [...byTime.values()].sort((a,b)=>a.observedAtMs-b.observedAtMs)){
    const bucket=Math.floor(row.observedAtMs/bucketMs)*bucketMs;
    if(!byBucket.has(bucket))byBucket.set(bucket,[]);
    byBucket.get(bucket).push({...row,bucket});
  }
  const intervals=[];
  // After a provider lowers a cumulative counter, later positive differences
  // may merely undo the correction. Do not label them as new activity until
  // a reading has crossed the last known pre-correction value.
  let revisionBaseline=null,previousReading=null,from=null;
  for(const readingsInBucket of byBucket.values()){
    let downwardMagnitude=0n,recoveryBaseline=null;
    // Inspect every actual observation before selecting the bucket endpoint.
    // Otherwise a drop and rebound inside one slot can disappear and the next
    // selected endpoint's increase can be mistaken for new activity.
    for(const reading of readingsInBucket){
      const value=BigInt(reading.value);
      if(previousReading!==null&&value<BigInt(previousReading.value)){
        const prior=BigInt(previousReading.value);
        downwardMagnitude+=prior-value;
        if(revisionBaseline===null||prior>revisionBaseline)revisionBaseline=prior;
      }else if(revisionBaseline!==null){
        if(recoveryBaseline===null||revisionBaseline>recoveryBaseline)recoveryBaseline=revisionBaseline;
        if(value>revisionBaseline)revisionBaseline=null;
      }
      previousReading=reading;
    }
    const to=readingsInBucket.at(-1);
    if(from===null){from=to;continue;}
    const base={fromAtMs:from.observedAtMs,toAtMs:to.observedAtMs,
      durationMs:to.observedAtMs-from.observedAtMs,
      fromRawSha256:from.rawSha256??null,toRawSha256:to.rawSha256??null};
    const change=BigInt(to.value)-BigInt(from.value);
    if(to.bucket-from.bucket!==bucketMs){
      intervals.push({...base,kind:'GAP',deltaCount:null});
    }else if(downwardMagnitude>0n){
      intervals.push({...base,kind:'DOWNWARD_REVISION',deltaCount:null,
        revisionMagnitude:downwardMagnitude.toString()});
    }else if(recoveryBaseline!==null){
      intervals.push({...base,kind:'REVISION_RECOVERY',deltaCount:null,
        revisionBaselineCount:recoveryBaseline.toString()});
    }else{
      intervals.push({...base,kind:'OBSERVED_DELTA',deltaCount:change.toString()});
    }
    from=to;
  }
  return {selectedReadings:byBucket.size,intervals};
}
