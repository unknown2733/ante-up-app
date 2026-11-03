#!/bin/sh
# Host cron entrypoint. The allowlisted driver signs at most one Devnet instruction
# per market and invocation. Weekly settlement starts after Monday 09:16 KST;
# same-week validity resets may reopen an empty LP window at other times.
set -eu
STATE=/srv/ante-up/builds/service-state
SECRETS=/srv/ante-up/secrets
IMAGE=${ANTE_UP_KEEPER_IMAGE:-ante-up:weekly-keeper-v1}
exec 9>"$STATE/keeper-auto/weekly.lock"
flock -n 9 || exit 0

# Keeper scans all historical Snapshot accounts when planning a matured cycle.
# Use the same verified archive as the live indexer, including after archive rotation.
INDEXER=$(docker ps --filter label=com.docker.compose.project=ante-up \
  --filter label=com.docker.compose.service=indexer --format '{{.ID}}' || true)
ARCHIVE_OK=no
if [ -n "$INDEXER" ] && [ "$(printf '%s\n' "$INDEXER" | wc -l)" -eq 1 ]; then
  INDEXER_ENV=$(docker inspect "$INDEXER" --format '{{range .Config.Env}}{{println .}}{{end}}' || true)
  ARCHIVE_PATH=$(printf '%s\n' "$INDEXER_ENV" | sed -n 's/^ANTE_UP_SNAPSHOT_ARCHIVE_PATH=//p')
  ARCHIVE_SHA=$(printf '%s\n' "$INDEXER_ENV" | sed -n 's/^ANTE_UP_SNAPSHOT_ARCHIVE_SHA256=//p')
  CLUSTER=$(printf '%s\n' "$INDEXER_ENV" | sed -n 's/^ANTE_UP_CLUSTER=//p')
  case "$ARCHIVE_PATH" in
    /state/archives/*)
      ARCHIVE_NAME=${ARCHIVE_PATH#/state/archives/}
      case "$ARCHIVE_NAME" in
        ''|*/*|*..*) ARCHIVE_FILE= ;;
        *) ARCHIVE_FILE="$STATE/archives/$ARCHIVE_NAME" ;;
      esac ;;
    *) ARCHIVE_FILE= ;;
  esac
  if [ "$CLUSTER" = devnet ] && [ -n "$ARCHIVE_FILE" ] && [ -f "$ARCHIVE_FILE" ] &&
      printf '%s' "$ARCHIVE_SHA" | grep -Eq '^[0-9a-f]{64}$' &&
      [ "$(sha256sum "$ARCHIVE_FILE" | cut -d ' ' -f 1)" = "$ARCHIVE_SHA" ]; then
    ARCHIVE_OK=yes
  fi
fi

if [ "$ARCHIVE_OK" = yes ] && docker run --rm --user 1000:1000 \
  -v "$STATE:/state" \
  -v "$SECRETS/devnet-rpc.secondary.url:/run/secrets/rpc.url:ro" \
  -v "$SECRETS/devnet-rpc.url:/run/secrets/rpc.fallback.url:ro" \
  -v "$SECRETS/devnet-publisher.json:/run/secrets/publisher.json:ro" \
  -v "$SECRETS/devnet-keeper.json:/run/secrets/keeper.json:ro" \
  -e ANTE_UP_WEEKLY_KEEPER_ENABLED=yes \
  -e ANTE_UP_WEEKLY_KEEPER_MARKETS=/state/keeper-auto/markets.json \
  -e ANTE_UP_RPC_URL_FILE=/run/secrets/rpc.url \
  -e ANTE_UP_RPC_FALLBACK_URL_FILE=/run/secrets/rpc.fallback.url \
  -e ANTE_UP_PUBLISHER_KEYPAIR_FILE=/run/secrets/publisher.json \
  -e ANTE_UP_KEEPER_KEYPAIR_FILE=/run/secrets/keeper.json \
  -e ANTE_UP_CLUSTER=devnet \
  -e ANTE_UP_SNAPSHOT_ARCHIVE_PATH="$ARCHIVE_PATH" \
  -e ANTE_UP_SNAPSHOT_ARCHIVE_SHA256="$ARCHIVE_SHA" \
  "$IMAGE" node scripts/weekly-keeper.mjs --execute \
  >"$STATE/keeper-auto/last-run.log" 2>&1; then
  STATUS=success
else
  STATUS=failure
  if [ "$ARCHIVE_OK" != yes ]; then
    printf '%s\n' 'KEEPER_SNAPSHOT_ARCHIVE_UNAVAILABLE' >"$STATE/keeper-auto/last-run.log"
  fi
fi

docker run --rm --user 1000:1000 \
  -v "$STATE:/state" \
  -v "$SECRETS/ops-telegram.token:/run/secrets/telegram.token:ro" \
  -v "$SECRETS/ops-telegram.chat-id:/run/secrets/telegram.chat-id:ro" \
  "$IMAGE" node scripts/weekly-keeper-notify.mjs "$STATUS" \
  /state/keeper-auto/alert-state.json /run/secrets/telegram.token /run/secrets/telegram.chat-id

[ "$STATUS" = success ]
