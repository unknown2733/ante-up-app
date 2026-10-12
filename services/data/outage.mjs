import { DAY, HISTORY_MINUTES, hash } from './index.mjs';

const check=(ok,code='INVALID_OUTAGE_TIMELINE')=>{if(!ok)throw new Error(code);};
const second=x=>Number.isSafeInteger(x) && x>=0;
const hex=x=>typeof x==='string' && /^[a-f0-9]{64}$/.test(x);
const incidentId=(marketId,startedAt,provenance)=>hash({marketId,startedAt,provenance});

export function validateOutageTimeline(marketId,timeline=[]) {
  check(Array.isArray(timeline));
  let previous=-1,previousRecoveredAt=-1,open=false;
  for(const incident of timeline){
    check(second(incident.startedAt) && incident.startedAt>previous &&
      incident.startedAt>=previousRecoveredAt &&
      incident.id===incidentId(marketId,incident.startedAt,incident.provenance) &&
      (incident.recoveredAt===null || second(incident.recoveredAt) && incident.recoveredAt>incident.startedAt));
    check(!open,'OVERLAPPING_OUTAGE');
    if(incident.provenance?.kind==='PERSISTED_RECOVERY_STATE')
      check(second(incident.provenance.dataThrough) &&
        incident.startedAt===incident.provenance.dataThrough+600);
    else if(incident.provenance?.kind==='INVALID_SOURCE')
      check(incident.startedAt===incident.provenance.invalidatedAt &&
        ['SOURCE_INVALID','INVALID_DENOMINATOR'].includes(incident.provenance.reason));
    else throw new Error('INVALID_OUTAGE_PROVENANCE');
    if(incident.provenance.rawHash!==undefined)
      check(hex(incident.provenance.rawHash) && typeof incident.provenance.batchId==='string' &&
        incident.provenance.batchId.length>0);
    if(incident.provenance.evidenceHash!==undefined)
      check(hex(incident.provenance.evidenceHash));
    previous=incident.startedAt;
    previousRecoveredAt=incident.recoveredAt??incident.startedAt;
    open=incident.recoveredAt===null;
  }
  return timeline;
}

export function openOutage(market,marketId,{startedAt,provenance}) {
  const timeline=validateOutageTimeline(marketId,market.outageTimeline??[]);
  const open=timeline.at(-1);
  if(open?.recoveredAt===null)return open; // Keep the first onset and its 24-hour deadline.
  check(second(startedAt) && (!open || startedAt>open.startedAt),'OUTAGE_ORDER_MISMATCH');
  const incident={id:incidentId(marketId,startedAt,provenance),startedAt,recoveredAt:null,provenance};
  validateOutageTimeline(marketId,[...timeline,incident]);
  market.outageTimeline=[...timeline,incident];
  return incident;
}

function hydrateLegacyOutage(market,marketId) {
  if(market.outageTimeline!==undefined || !second(market.recoveryState?.outageStartAt))return;
  const startedAt=market.recoveryState.outageStartAt;
  check(startedAt>=600 && (market.recoveryState.emergencyAt==null ||
    market.recoveryState.emergencyAt===startedAt+DAY),'LEGACY_OUTAGE_STATE_MISMATCH');
  openOutage(market,marketId,{startedAt,
    provenance:{kind:'PERSISTED_RECOVERY_STATE',dataThrough:startedAt-600}});
}

export function markSourceInvalid(market,marketId,at,{rawHash=null,batchId=null}={}) {
  check(second(at));
  hydrateLegacyOutage(market,marketId);
  check((rawHash===null && batchId===null) || (hex(rawHash) &&
    typeof batchId==='string' && batchId.length>0));
  const incident=openOutage(market,marketId,{startedAt:at,
    provenance:{kind:'INVALID_SOURCE',invalidatedAt:at,reason:'SOURCE_INVALID',
      ...(rawHash===null?{}:{rawHash,batchId})}});
  if(market.recoveryState){
    market.recoveryState.outageStartAt=incident.startedAt;
    market.recoveryState.emergencyAt=incident.startedAt+DAY;
    market.recoveryState.admission={state:'BLOCKED',recoveryCount:0,reason:'DATA_NOT_READY'};
  }
  return incident;
}

// Called after a validated replay, not after a failed HTTP attempt. Its result
// can be persisted inside the existing FileCollectionState market entry.
export function updateOutageTimeline(market,marketId,result,{at,replayEnd,historyStart,batchId=null}) {
  check(second(at) && second(replayEnd) && second(historyStart));
  hydrateLegacyOutage(market,marketId);
  const timeline=validateOutageTimeline(marketId,market.outageTimeline??[]);
  const state=result.state,candidate=result.candidate;
  let incident=timeline.at(-1)?.recoveredAt===null?timeline.at(-1):null;
  if(candidate.reason==='INVALID_DENOMINATOR' &&
    candidate.dataThrough>=historyStart+HISTORY_MINUTES*60){
    incident=openOutage(market,marketId,{startedAt:incident?.startedAt??at,
      provenance:{kind:'INVALID_SOURCE',invalidatedAt:at,reason:'INVALID_DENOMINATOR',
        ...(hex(candidate.evidenceHash)?{evidenceHash:candidate.evidenceHash}:{}),
        ...(batchId?{batchId}:{})}});
  } else if(state.outageStartAt!==null && candidate.dataThrough>=historyStart+HISTORY_MINUTES*60){
    incident=openOutage(market,marketId,{startedAt:state.outageStartAt,
      provenance:{kind:'PERSISTED_RECOVERY_STATE',dataThrough:state.outageStartAt-600,
        ...(hex(candidate.evidenceHash)?{evidenceHash:candidate.evidenceHash}:{}),
        ...(batchId?{batchId}:{})}});
  }
  const complete=candidate.dataThrough===replayEnd &&
    ['VALID','LOW_ACTIVITY'].includes(candidate.dataStatus);
  if(incident && complete){
    check(at>incident.startedAt,'OUTAGE_RECOVERY_TIME_MISMATCH');
    incident.recoveredAt=at;
    state.outageStartAt=null;state.emergencyAt=null;
  } else if(incident){
    state.outageStartAt=incident.startedAt;
    state.emergencyAt=incident.startedAt+DAY;
  }
  market.outageTimeline=market.outageTimeline??timeline;
  market.recoveryState=state;
  return incident;
}

// The earliest missed 24-hour deadline wins even if a later outage has started.
// Otherwise use the incident still active at the fixed T+900 cutoff.
export function selectOutageForEpoch(market,marketId,{epochStartedAt,maturityAt,now}) {
  check(second(epochStartedAt) && second(maturityAt) && epochStartedAt<maturityAt && second(now));
  let timeline=validateOutageTimeline(marketId,market.outageTimeline??[]);
  if(timeline.length===0 && second(market.recoveryState?.outageStartAt)){
    const startedAt=market.recoveryState.outageStartAt;
    check(startedAt>=600 && (market.recoveryState.emergencyAt==null ||
      market.recoveryState.emergencyAt===startedAt+DAY),'LEGACY_OUTAGE_STATE_MISMATCH');
    const provenance={kind:'PERSISTED_RECOVERY_STATE',dataThrough:startedAt-600};
    timeline=[{id:incidentId(marketId,startedAt,provenance),startedAt,recoveredAt:null,provenance}];
  }
  const cutoffAt=maturityAt+900;
  const missed=timeline.find(i=>i.startedAt>=epochStartedAt && i.startedAt<=now &&
    i.startedAt<=cutoffAt && i.startedAt+DAY<=now &&
    (i.recoveredAt===null || i.recoveredAt>i.startedAt+DAY));
  if(missed){check(missed.recoveredAt===null || missed.recoveredAt<=now,'OUTAGE_TIMELINE_FUTURE');return missed;}
  const active=timeline.find(i=>i.startedAt>=epochStartedAt && i.startedAt<=now && i.startedAt<=cutoffAt &&
    (i.recoveredAt===null || i.recoveredAt>cutoffAt))??null;
  if(active)check(active.recoveredAt===null || active.recoveredAt<=now,'OUTAGE_TIMELINE_FUTURE');
  return active;
}

// Read-only handoff for an authorized B/D gate writer. It is not an on-chain
// transaction and must not be shown as a finalized admission change.
export function getAdmissionGateIntent(market,marketId) {
  const timeline=validateOutageTimeline(marketId,market.outageTimeline??[]);
  const current=timeline.at(-1);
  if(!current || current.recoveredAt!==null || current.provenance.kind!=='INVALID_SOURCE')return null;
  return {marketId,incidentId:current.id,blockedAt:current.startedAt,
    state:'BLOCKED',reason:'DATA_NOT_READY',provenance:current.provenance};
}
