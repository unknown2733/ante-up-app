import {existsSync,readFileSync,lstatSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {resolve,join,relative,dirname,sep,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {planHistoryArchive,stageHistoryArchive,pruneCurrentHistoryArchive,validateArchiveManifest} from '../../services/data/history-archive.mjs';

const check=(ok,code)=>{if(!ok)throw Error(code);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const inside=(base,path)=>{const p=relative(resolve(base),resolve(path));return !p||p!=='..'&&!p.startsWith(`..${sep}`)&&!isAbsolute(p);};
function atomicReport(path,report){
  mkdirSync(dirname(path),{recursive:true});const tmp=`${path}.${process.pid}.tmp`,fd=openSync(tmp,'w',0o600);
  try{writeFileSync(fd,JSON.stringify(report));fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,path);
}
function readJson(path){
  check(lstatSync(path).isFile(),'HISTORY_MAINTENANCE_RECEIPT_NOT_FILE');
  try{return JSON.parse(readFileSync(path));}catch(error){if(error instanceof SyntaxError)throw Error('HISTORY_MAINTENANCE_RECEIPT_INVALID');throw error;}
}
function receiptForInventory(copy,drill,manifestSha256,{now,expectedDestinationId}){
  check(copy?.version===1&&copy.kind==='backup-copy'&&copy.verification==='destination-readback-sha256'&&
    hex(copy.sha256)&&Number.isSafeInteger(copy.bytes)&&copy.bytes>0&&typeof copy.artifact==='string'&&copy.artifact.length>0&&
    typeof copy.destinationId==='string'&&copy.destinationId.length>0,'HISTORY_MAINTENANCE_COPY_INVALID');
  if(expectedDestinationId)check(copy.destinationId===expectedDestinationId,'HISTORY_MAINTENANCE_DESTINATION_MISMATCH');
  check(drill?.version===1&&drill.kind==='isolated-restore-drill'&&hex(drill.backupSha256),'HISTORY_MAINTENANCE_DRILL_INVALID');
  check(drill.hashes==='matched'&&drill.sqlite==='quick_check-schema-row-counts-matched','HISTORY_MAINTENANCE_RESTORE_FAILED');
  // The PC may publish copy and drill receipts separately; mixed generations wait.
  if(copy.sha256!==drill.backupSha256)return {ready:false,reason:'COPY_DRILL_BACKUP_MISMATCH'};
  const copied=Date.parse(copy.verifiedAt),restored=Date.parse(drill.verifiedAt),created=Date.parse(drill.backupCreatedAt);
  check(Number.isFinite(copied)&&Number.isFinite(restored)&&Number.isFinite(created)&&created<=copied&&copied<=restored&&
    restored<=now+300_000,'HISTORY_MAINTENANCE_RECEIPT_TIME_INVALID');
  const receipt=drill.historyArchive;
  if(!receipt)return {ready:false,reason:'ARCHIVE_RESTORE_NOT_AVAILABLE'};
  check(receipt.kind==='HISTORY_ARCHIVE_RESTORE_VERIFICATION'&&receipt.hashes==='matched'&&hex(receipt.manifestSha256)&&
    Number.isSafeInteger(receipt.entries)&&receipt.entries>=0,'HISTORY_MAINTENANCE_ARCHIVE_RECEIPT_INVALID');
  if(receipt.manifestSha256!==manifestSha256)return {ready:false,reason:'ARCHIVE_RECEIPT_MANIFEST_MISMATCH'};
  return {ready:true,receipt,backupSha256:copy.sha256};
}

/** Run inside the existing backup locks while all state writers are quiesced.
 * No timers, process control, provider calls, signatures or backups are performed here.
 * A failed result must not prevent the wrapper from making a recoverable backup,
 * but must keep the overall maintenance/cycle outcome failed.
 */
export function runHistoryMaintenance(input,{now=Date.now()}={}){
  check(input&&typeof input.stateRoot==='string'&&typeof input.archiveRoot==='string'&&typeof input.report==='string',
    'HISTORY_MAINTENANCE_ARGUMENTS_INVALID');
  const stateRoot=resolve(input.stateRoot),archiveRoot=resolve(input.archiveRoot),reportPath=resolve(input.report);
  const collections=input.collections??['live-smoke','tariff'];
  check(Array.isArray(collections)&&collections.length>0&&new Set(collections).size===collections.length&&
    collections.every(c=>typeof c==='string'&&/^[a-zA-Z0-9_-]+$/.test(c)),'HISTORY_COLLECTION_INVALID');
  check(inside(stateRoot,archiveRoot)&&archiveRoot!==stateRoot,'HISTORY_ARCHIVE_PATH_INVALID');
  check(!inside(archiveRoot,reportPath)&&!inside(join(stateRoot,'keeper-auto'),reportPath)&&
    collections.every(c=>!inside(join(stateRoot,c),reportPath)),'HISTORY_MAINTENANCE_REPORT_PATH_INVALID');
  const receiptDir=input.receiptDir&&resolve(input.receiptDir);
  const copyPath=input.copyReceipt&&resolve(input.copyReceipt)||receiptDir&&join(receiptDir,'latest-copy.json');
  const drillPath=input.drillReceipt&&resolve(input.drillReceipt)||receiptDir&&join(receiptDir,'latest-drill.json');
  check(copyPath&&drillPath&&reportPath!==copyPath&&reportPath!==drillPath,'HISTORY_MAINTENANCE_RECEIPT_PATH_REQUIRED');
  const protectedPaths=['keeper-auto',...collections.filter(c=>existsSync(join(stateRoot,c,'evidence','jobs.json'))).map(c=>`${c}/evidence`)];
  const options={stateRoot,archiveRoot,collections,protectedPaths};
  const report={version:1,kind:'HISTORY_ARCHIVE_MAINTENANCE',startedAt:new Date(now).toISOString(),status:'RUNNING',phases:[]};
  function record(name,status,detail={}){report.phases.push({name,status,...detail});atomicReport(reportPath,report);}
  try{
    check(input.quiesced===true,'HISTORY_WRITERS_MUST_BE_QUIESCED');
    const manifestPath=join(archiveRoot,'manifest.json');
    let inventory=null;
    if(existsSync(manifestPath)){
      check(lstatSync(manifestPath).isFile(),'HISTORY_ARCHIVE_MANIFEST_INVALID');
      const bytes=readFileSync(manifestPath);inventory=validateArchiveManifest(JSON.parse(bytes));report.manifestBefore=sha(bytes);
      if(!existsSync(copyPath)||!existsSync(drillPath)){
        record('receipt','AWAITING',{reason:'RESTORE_RECEIPT_MISSING'});
        report.status='AWAITING_RESTORE';
      }else{
        const eligibility=receiptForInventory(readJson(copyPath),readJson(drillPath),report.manifestBefore,
          {now,expectedDestinationId:input.expectedDestinationId});
        if(!eligibility.ready){record('receipt','AWAITING',{reason:eligibility.reason});report.status='AWAITING_RESTORE';}
        else{
          check(eligibility.receipt.entries===inventory.entries.length,'HISTORY_MAINTENANCE_RECEIPT_COUNT_MISMATCH');
          record('receipt','VERIFIED',{backupSha256:eligibility.backupSha256,manifestSha256:report.manifestBefore});
          record('prune','RUNNING');
          const pruned=pruneCurrentHistoryArchive(options,eligibility.receipt,{quiesced:true});
          record('prune','COMPLETE',{removed:pruned.removed,manifestSha256:pruned.manifestSha256});
          report.status='PRUNED';
        }
      }
    }
    // Hold the inventory unchanged while waiting for its exact offhost restore.
    if(report.status!=='AWAITING_RESTORE'){
      record('plan','RUNNING');const plan=planHistoryArchive(options);
      record('plan','COMPLETE',{blobs:plan.entries.length,archiveBytes:plan.archiveBytes,protectedBytes:plan.protectedBytes});
      if(plan.entries.length||!inventory){
        record('stage','RUNNING');const staged=stageHistoryArchive(plan,{quiesced:true});
        record('stage','COMPLETE',{manifestSha256:staged.manifestSha256,entries:staged.entries,bytes:staged.bytes});
        report.status='STAGED';report.manifestAfter=staged.manifestSha256;
      }else{record('stage','NO_CHANGES');report.manifestAfter=report.manifestBefore;}
    }else report.manifestAfter=report.manifestBefore;
  }catch(error){
    report.status='FAILED';report.error=/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'HISTORY_MAINTENANCE_FAILED';
    record('failure','FAILED',{code:report.error});
  }
  report.finishedAt=new Date().toISOString();atomicReport(reportPath,report);return report;
}

export function main(argv){
  const names={'--state-root':'stateRoot','--archive-root':'archiveRoot','--receipt-dir':'receiptDir','--report':'report',
    '--copy-receipt':'copyReceipt','--drill-receipt':'drillReceipt','--destination-id':'expectedDestinationId'};
  const input={};
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];if(flag==='--quiesced'){check(!input.quiesced,'HISTORY_MAINTENANCE_ARGUMENTS_INVALID');input.quiesced=true;}
    else if(flag==='--collection'){check(argv[i+1]&&!argv[i+1].startsWith('--'),'HISTORY_MAINTENANCE_ARGUMENTS_INVALID');(input.collections??=[]).push(argv[++i]);}
    else{const field=names[flag];check(field&&!input[field]&&argv[i+1]&&!argv[i+1].startsWith('--'),'HISTORY_MAINTENANCE_ARGUMENTS_INVALID');input[field]=argv[++i];}
  }
  return runHistoryMaintenance(input);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const result=main(process.argv.slice(2));console.log(JSON.stringify(result));if(result.status==='FAILED')process.exitCode=1;}
  catch(error){console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'HISTORY_MAINTENANCE_FAILED');process.exitCode=1;}
}
