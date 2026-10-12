#!/bin/sh
set -eu
# Run on the home server from the selected release root; image must include these scripts.
# Never invoke graduate-demo before the live UI and human LP tester are ready.
: "${ANTE_UP_IMAGE:?set the verified release image}"
stage=${1:-preflight}
case "$stage" in preflight|prepare-demo|graduate-demo|refresh|status|feed) ;; *) echo 'unsupported stage' >&2; exit 2;; esac
if [ "$stage" = graduate-demo ] || [ "$stage" = refresh ] || [ "$stage" = feed ]; then
  test "${ANTE_UP_QA_CANDIDATE_IMPORT_READY:-no}" = yes
fi
entry=scripts/qa-finance-devnet.mjs
if [ "$stage" = feed ]; then entry=scripts/demo-financial-feed.mjs; fi
docker run --rm --user 1000:1000 \
  -v /srv/ante-up/secrets/devnet-rpc.url:/run/secrets/rpc.url:ro \
  -v /srv/ante-up/secrets/devnet-deployer.json:/run/secrets/admin.json:ro \
  -v /srv/ante-up/secrets/devnet-publisher.json:/run/secrets/publisher.json:ro \
  -v /srv/ante-up/builds/service-state:/state \
  -e ANTE_UP_QA_RPC_FILE=/run/secrets/rpc.url \
  -e ANTE_UP_QA_ADMIN_FILE=/run/secrets/admin.json \
  -e ANTE_UP_QA_PUBLISHER_FILE=/run/secrets/publisher.json \
  -e ANTE_UP_QA_STATE_DIR=/state/financial-demo-20261013 \
  -e ANTE_UP_QA_PROFILE=demo \
  -e ANTE_UP_QA_CANDIDATE_IMPORT_READY="${ANTE_UP_QA_CANDIDATE_IMPORT_READY:-no}" \
  -e ANTE_UP_QA_SCENARIO="${ANTE_UP_QA_SCENARIO:-baseline}" \
  -e ANTE_UP_DEMO_FEED_PASSES="${ANTE_UP_DEMO_FEED_PASSES:-15}" \
  "$ANTE_UP_IMAGE" node "$entry" "$stage"
