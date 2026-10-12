import {spawnSync} from 'node:child_process';
import {readdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const directories=['contracts','tests/chain','clients/chain/test','services/data','services/evidence','services/api/test','services/indexer/test','services/keeper/test','tests/integration'];
function collect(dir){
  if(!existsSync(dir))return [];
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    if(entry.isSymbolicLink()||['node_modules','dist','target','.runtime','.local','.tools'].includes(entry.name))return [];
    const path=join(dir,entry.name);
    return entry.isDirectory()?collect(path):/\.test\.(mjs|ts)$/.test(entry.name)?[path]:[];
  });
}
const files=[...new Set(directories.flatMap(dir=>collect(join(root,dir))))];
const env={...process.env,ANTE_UP_D_APP_PATH:join(root,'services/api/src/app.ts'),ANTE_UP_HTTP_TEST:'1'};
function run(args,cwd=root){
  const result=spawnSync(process.execPath,args,{cwd,env,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
const chain=join(root,'clients/chain');
if(existsSync(join(chain,'tsconfig.build.json'))) {
  run(['node_modules/typescript/bin/tsc','--noEmit'],chain);
  run(['node_modules/typescript/bin/tsc','-p','tsconfig.build.json'],chain);
}
for(const path of ['services/api','services/indexer']) {
  const module=join(root,path);
  if(existsSync(join(module,'tsconfig.json'))) run(['node_modules/typescript/bin/tsc','--noEmit'],module);
}
run(['--test','--test-isolation=none',...files]);
const web=join(root,'apps/web');
run(['--test',...collect(join(web,'tests'))],web);
run(['node_modules/typescript/bin/tsc','-b'],web);
run(['node_modules/vite/bin/vite.js','build'],web);
console.log('PASS: local module/adapter tests, fixture integration and web build. Compiled chain execution and live providers are separate gates; skipped tests are not passed gates.');
