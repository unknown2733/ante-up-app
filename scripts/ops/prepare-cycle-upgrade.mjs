// Produce reviewed replacements in a separate directory; never install or run them.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {check,args,inside} from './common.mjs';
const runningCheck='for name in "${names[@]}"; do\n  test "$(docker inspect "$name" --format \'{{.State.Running}}\')" = true\ndone';
export function prepareCycleUpgrade({cycle,runner,supervisor}){
  check(/^\/[A-Za-z0-9_./-]+\/backup-cycle\.mjs$/.test(supervisor)&&!supervisor.includes('/../'),'SUPERVISOR_PATH_INVALID');
  cycle=cycle.replaceAll('\r\n','\n');runner=runner.replaceAll('\r\n','\n');
  const tail='bash "$base/run-backup.sh"\n\n'+runningCheck+'\ntest "$(curl --silent --show-error --max-time 12 --output /dev/null --write-out \'%{http_code}\' https://ante-up.fun/)" = 200\ntest "$(curl --silent --show-error --max-time 12 --output /dev/null --write-out \'%{http_code}\' https://ante-up.fun/api/v1/markets)" = 200\necho BACKUP_CYCLE_COMPLETE';
  check(cycle.endsWith(tail+'\n')&&cycle.split(tail).length===2,'BACKUP_CYCLE_SOURCE_UNRECOGNIZED');
  const runnerTail=runningCheck+'\nprintf \'backup_created=%s\\n\' "$artifact"\nstat -c \'backup_bytes=%s\' "$artifact"';
  check(runner.endsWith(runnerTail+'\n')&&runner.includes('trap resume EXIT')&&runner.includes('resume\nstopped=0\ntrap - EXIT'),'BACKUP_RUNNER_SOURCE_UNRECOGNIZED');
  // The child retains EXIT restoration. Only its immediate post-start check is
  // replaced; the supervisor reports bounded recovery separately from creation.
  runner=runner.slice(0,-(runnerTail+'\n').length)+'printf \'backup_created=%s\\n\' "$artifact"\nstat -c \'backup_bytes=%s\' "$artifact"\n';
  cycle=cycle.slice(0,-(tail+'\n').length)+`node '${supervisor}' --base "$base" --services "$(IFS=,; echo "\${names[*]}")"\necho BACKUP_CYCLE_COMPLETE\n`;
  return {cycle,runner};
}
async function main(){
  const a=args(process.argv.slice(2),['--base','--output','--supervisor']);check(a['--base']&&a['--output'],'UPGRADE_ARGUMENTS_REQUIRED');
  const base=resolve(a['--base']),out=resolve(a['--output']);check(!inside(base,out)&&!inside(out,base),'UPGRADE_OUTPUT_MUST_BE_SEPARATE');
  const result=prepareCycleUpgrade({cycle:await readFile(join(base,'run-backup-cycle.sh'),'utf8'),runner:await readFile(join(base,'run-backup.sh'),'utf8'),supervisor:a['--supervisor']});
  await mkdir(out,{recursive:true,mode:0o700});
  await writeFile(join(out,'run-backup-cycle.sh'),result.cycle,{flag:'wx',mode:0o700});
  await writeFile(join(out,'run-backup.sh'),result.runner,{flag:'wx',mode:0o700});console.log('BACKUP_UPGRADE_PREPARED_NOT_INSTALLED');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'UPGRADE_PREPARATION_FAILED');process.exitCode=1;});
