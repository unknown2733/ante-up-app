#!/bin/sh
# Host cron entrypoint. The allowlisted driver signs at most one Devnet instruction
# per market and invocation, only after the Monday 09:16 KST data cutoff.
set -eu
STATE=/srv/ante-up/builds/service-state
SECRETS=/srv/ante-up/secrets
IMAGE=ante-up:weekly-keeper-v1
exec 9>"$STATE/keeper-auto/weekly.lock"
flock -n 9 || exit 0

if docker run --rm --user 1000:1000 \
  -v "$STATE:/state" \
  -v "$SECRETS/devnet-rpc.secondary.url:/run/secrets/rpc.url:ro" \
  -v "$SECRETS/devnet-publisher.json:/run/secrets/publisher.json:ro" \
  -v "$SECRETS/devnet-keeper.json:/run/secrets/keeper.json:ro" \
  -e ANTE_UP_WEEKLY_KEEPER_ENABLED=yes \
  -e ANTE_UP_WEEKLY_KEEPER_MARKETS=/state/keeper-auto/markets.json \
  -e ANTE_UP_RPC_URL_FILE=/run/secrets/rpc.url \
  -e ANTE_UP_PUBLISHER_KEYPAIR_FILE=/run/secrets/publisher.json \
  -e ANTE_UP_KEEPER_KEYPAIR_FILE=/run/secrets/keeper.json \
  "$IMAGE" node scripts/weekly-keeper.mjs --execute \
  >"$STATE/keeper-auto/last-run.log" 2>&1; then
  STATUS=success
else
  STATUS=failure
fi

docker run --rm --user 1000:1000 \
  -v "$STATE:/state" \
  -v "$SECRETS/ops-telegram.token:/run/secrets/telegram.token:ro" \
  -v "$SECRETS/ops-telegram.chat-id:/run/secrets/telegram.chat-id:ro" \
  "$IMAGE" node scripts/weekly-keeper-notify.mjs "$STATUS" \
  /state/keeper-auto/alert-state.json /run/secrets/telegram.token /run/secrets/telegram.chat-id

[ "$STATUS" = success ]
