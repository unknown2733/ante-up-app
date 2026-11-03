"""Linux-only offline harness for an operator-supplied host prepare wrapper.

Usage: python3 scripts/ops/test-host-prepare-failures.py /path/to/reviewed-wrapper.sh
No live config, keys, Docker socket, timers or services are used. All privileged
commands are replaced with executables in an isolated PATH. The source wrapper
is read and its deployment paths are rewritten in the temporary copy only.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


source = Path(sys.argv[1]).read_bytes()
assert os.name == "posix", "Linux fixture required"
for fault in ("missing-config", "image-save-failed"):
    with tempfile.TemporaryDirectory(prefix="ante-prepare-fixture-") as tmp:
        root = Path(tmp)
        host = root / "host"
        base = host / "builds/ops-recovery-20261016"
        state = host / "builds/service-state"
        bin_dir = root / "bin"
        for directory in (base / "recovery-config", base / "ops-config", state / "archives", host / "secrets", bin_dir):
            directory.mkdir(parents=True, exist_ok=True)
        for file in (host / "builds/always-on-20261012/deploy/evidence-budget.env",
                     host / "builds/visitor-onboarding-174c8e4/visitor-sol.env", base / "ops-monitor.env"):
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("synthetic-only\n")
        if fault == "missing-config":
            (base / "ops-monitor.env").unlink()
        (state / "archives/archive.sqlite").write_text("synthetic archive presence only")
        prior = base / "backup-result.json"
        prior.write_text('{"syntheticPreviousSuccess":true}\n')
        before = prior.read_bytes()
        calls = root / "calls.jsonl"
        stub = bin_dir / "stub"
        stub.write_text("""#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
name=Path(sys.argv[0]).name;args=sys.argv[1:];root=Path(os.environ['FIXTURE_ROOT']);host=root/'host'
with (root/'calls.jsonl').open('a') as f:f.write(json.dumps([name,args])+'\\n')
if name=='docker':
    if args[0]=='save':sys.exit(73)
    if args[0]=='inspect':
        fmt=args[args.index('--format')+1] if '--format' in args else ''
        if '.Mounts' in fmt:print(host/'builds/service-state')
        elif '.State.Running' in fmt:print('true')
        elif '.Config.Image' in fmt:print('ante-up-ops:fixture' if 'ante-up-ops-monitor-1' in args else 'ante-up:fixture')
        elif '.Config.Env' in fmt:print('ANTE_UP_SNAPSHOT_ARCHIVE_PATH=/state/archives/archive.sqlite\\nANTE_UP_SNAPSHOT_ARCHIVE_SHA256='+'a'*64)
        elif '.Image' in fmt:print('sha256:'+'1'*64)
        else:print('[]')
    elif args[:2]==['image','inspect']:print('sha256:'+'2'*64 if '--format' in args else '[]')
    else:sys.exit(97)
elif name=='crontab':print('*/2 * * * * ANTE_UP_KEEPER_IMAGE=ante-up:fixture '+str(host/'builds/keeper/run-weekly-keeper.sh'))
elif name=='systemctl':print('ante-up:fixture')
elif name=='df':print('Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 100000000 0 100000000 0% /')
else:sys.exit(98)
""")
        stub.chmod(0o700)
        for name in ("docker", "crontab", "systemctl", "df"):
            shutil.copy2(stub, bin_dir / name)
        # Replace jq too: these failure paths must stop before any jq or later
        # backup command. Calling it is an unexpected progress assertion.
        (bin_dir / "jq").write_text("#!/bin/sh\nexit 99\n")
        (bin_dir / "jq").chmod(0o700)
        wrapper = root / "prepare.sh"
        wrapper.write_text(source.decode().replace("/srv/ante-up", str(host)))
        env = dict(os.environ, PATH=str(bin_dir) + ":/usr/local/bin:/usr/bin:/bin", FIXTURE_ROOT=str(root))
        result = subprocess.run(["bash", str(wrapper), "prepare"], env=env, capture_output=True, text=True)
        assert result.returncode == (2 if fault == "missing-config" else 73), (fault, result.returncode, result.stderr)
        assert "BACKUP_METADATA_PREPARED" not in result.stdout
        assert prior.read_bytes() == before
        assert not list(base.glob("output/*.aub"))
        records = [json.loads(line) for line in calls.read_text().splitlines()]
        assert not any(name == "docker" and args[0] in ("run", "stop", "start", "restart", "compose") for name, args in records)
        if fault == "image-save-failed":
            assert any(name == "docker" and args[0] == "save" for name, args in records)
        print(json.dumps({"fault": fault, "passed": True, "previousReportPreserved": True, "serviceActions": 0}))
print("HOST_PREPARE_FAILURE_FIXTURES_PASSED sourceSha256=" + hashlib.sha256(source).hexdigest())
