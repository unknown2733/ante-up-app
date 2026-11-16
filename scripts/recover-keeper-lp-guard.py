#!/usr/bin/env python3
"""Host-only operator launcher. Acquires the existing backup and weekly locks.
No services are stopped, no transaction is signed, no lock is removed.
The Node verifier checks inherited fd ownership again immediately before commit.
"""
import fcntl, os, pathlib, sys
if len(sys.argv) < 3:
    raise SystemExit('usage: recover-keeper-lp-guard.py NODE CLI [CLI arguments]')
paths = ['/srv/ante-up/builds/ops-recovery-20261016/backup-cycle.lock',
         '/srv/ante-up/builds/service-state/keeper-auto/weekly.lock']
for fd, path in zip([8, 9], paths):
    original = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    os.dup2(original, fd, inheritable=True)
    if original != fd: os.close(original)
    try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: raise SystemExit('KEEPER_EXPIRY_LOCK_BUSY')
os.execv(sys.argv[1], sys.argv[1:])
