#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo 'Usage: run-reference-kworb.sh <reviewed-image-tag>' >&2
  exit 2
fi
state_dir=${ANTE_UP_HOST_STATE_DIR:?set the host state directory}
exec flock -n -F "$state_dir/reference-kworb.lock" \
  docker run --rm --read-only --tmpfs /tmp --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges \
  -v "$state_dir:/state" \
  "$1" \
  node services/api/src/reference-kworb-schedule.ts /state/live-smoke/index.sqlite
