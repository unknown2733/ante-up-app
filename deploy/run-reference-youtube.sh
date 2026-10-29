#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo 'Usage: run-reference-youtube.sh <reviewed-image-tag>' >&2
  exit 2
fi

state_dir=${ANTE_UP_HOST_STATE_DIR:?set the host state directory}
secret_file=${ANTE_UP_YOUTUBE_API_KEY_FILE:?set the private YouTube API key file}
cadence=${ANTE_UP_YOUTUBE_CADENCE:-reference}
if [[ "$cadence" != reference && "$cadence" != oracle-prep ]]; then
  echo 'YouTube cadence must be reference or oracle-prep' >&2
  exit 2
fi
if [[ ! -s "$secret_file" ]]; then
  echo 'YouTube API key file is missing or empty' >&2
  exit 2
fi

exec flock -n -F "$state_dir/reference-youtube.lock" \
  docker run --rm --read-only --tmpfs /tmp --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges \
  -e ANTE_UP_YOUTUBE_API_KEY_FILE=/run/secrets/youtube-api.key \
  -e ANTE_UP_YOUTUBE_ALLOW_QUOTA=1 \
  -e ANTE_UP_YOUTUBE_CADENCE="$cadence" \
  -v "$state_dir:/state" \
  -v "$secret_file:/run/secrets/youtube-api.key:ro" \
  "$1" \
  node services/api/src/reference-youtube-schedule.ts /state/live-smoke/index.sqlite
