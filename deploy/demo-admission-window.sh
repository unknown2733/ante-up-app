#!/bin/sh
set -eu
# Start inside a container with the mounted RPC/admin files and /state volume.
# One session per journal directory. No automatic restart policy.
trap 'if [ -f /state/financial-demo-20261013/admission-open.json ]; then node /app/scripts/demo-admission.mjs close; fi' EXIT
trap 'exit 0' TERM INT
node /app/scripts/demo-admission.mjs open
sleep 3600 &
wait "$!"
