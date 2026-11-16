import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCycleUpgrade} from './prepare-cycle-upgrade.mjs';
const running='for name in "${names[@]}"; do\n  test "$(docker inspect "$name" --format \'{{.State.Running}}\')" = true\ndone';
const cycle=`#!/bin/bash\nset -Eeuo pipefail\n${running}\nbash "$base/run-backup.sh"\n\n${running}\ntest "$(curl --silent --show-error --max-time 12 --output /dev/null --write-out '%{http_code}' https://ante-up.fun/)" = 200\ntest "$(curl --silent --show-error --max-time 12 --output /dev/null --write-out '%{http_code}' https://ante-up.fun/api/v1/markets)" = 200\necho BACKUP_CYCLE_COMPLETE\n`;
const runner=`#!/bin/bash\nset -Eeuo pipefail\ntrap resume EXIT\n${running}\n# existing backup and locks\nresume\nstopped=0\ntrap - EXIT\n\n${running}\nprintf 'backup_created=%s\\n' "$artifact"\nstat -c 'backup_bytes=%s' "$artifact"\n`;
test('upgrade preserves preflight and EXIT restoration, moves only immediate final checks',()=>{
 const r=prepareCycleUpgrade({cycle,runner,supervisor:'/reviewed/scripts/ops/backup-cycle.mjs'});
 assert.ok(r.runner.includes('trap resume EXIT'));assert.ok(r.runner.includes('# existing backup and locks'));
 assert.equal(r.runner.split(running).length,2);assert.equal(r.cycle.split(running).length,2);
 assert.ok(r.cycle.includes('node \'/reviewed/scripts/ops/backup-cycle.mjs\' --base "$base" --services "$(IFS=,; echo "${names[*]}")"'));
 assert.throws(()=>prepareCycleUpgrade({cycle:r.cycle,runner:r.runner,supervisor:'/reviewed/scripts/ops/backup-cycle.mjs'}),/UNRECOGNIZED/);
});
test('unknown wrapper and unsafe executable path fail without a guessed rewrite',()=>{
 assert.throws(()=>prepareCycleUpgrade({cycle:cycle.replace('curl','wget'),runner,supervisor:'/reviewed/backup-cycle.mjs'}),/UNRECOGNIZED/);
 assert.throws(()=>prepareCycleUpgrade({cycle,runner,supervisor:'/tmp/../secret/backup-cycle.mjs'}),/PATH_INVALID/);
});
