import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {planHistoryArchive,stageHistoryArchive,verifyHistoryArchive,pruneHistoryArchive,pruneCurrentHistoryArchive} from '../services/data/history-archive.mjs';

function protectedPaths(stateRoot,collections){
  return ['keeper-auto',...collections.map(c=>`${c}/evidence`).filter(p=>{
    try{readFileSync(resolve(stateRoot,p,'jobs.json'));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}
  })];
}

export function main(argv){
  const mode=argv.shift();
  if(mode==='--plan'){
    const [stateRoot,archiveRoot,output,...collections]=argv;
    if(!stateRoot||!archiveRoot||!output||!collections.length)throw Error('HISTORY_ARGUMENTS_INVALID');
    // Evidence and Keeper roots conservatively stay active; preserve all historical blob bytes.
    const plan=planHistoryArchive({stateRoot,archiveRoot,collections,protectedPaths:protectedPaths(stateRoot,collections)});
    writeFileSync(output,JSON.stringify(plan),{flag:'wx',mode:0o600});
    return {kind:plan.kind,blobs:plan.entries.length,archiveBytes:plan.archiveBytes,protectedBytes:plan.protectedBytes};
  }
  if(mode==='--verify'&&argv.length===1)return verifyHistoryArchive(argv[0]);
  if(mode==='--stage'&&argv.length===2&&argv[1]==='--quiesced')
    return stageHistoryArchive(JSON.parse(readFileSync(argv[0])),{quiesced:true});
  if(mode==='--prune'&&argv.length===3&&argv[2]==='--quiesced')
    return pruneHistoryArchive(JSON.parse(readFileSync(argv[0])),JSON.parse(readFileSync(argv[1])),{quiesced:true});
  if(mode==='--prune-current'&&argv.length>=5&&argv.at(-1)==='--quiesced'){
    const [stateRoot,archiveRoot,receipt,...collections]=argv.slice(0,-1);
    return pruneCurrentHistoryArchive({stateRoot,archiveRoot,collections,protectedPaths:protectedPaths(stateRoot,collections)},
      JSON.parse(readFileSync(receipt)),{quiesced:true});
  }
  throw Error('HISTORY_ARGUMENTS_INVALID');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(main(process.argv.slice(2))));}
  catch(e){console.error(/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'HISTORY_ARCHIVE_FAILED');process.exitCode=1;}
}
