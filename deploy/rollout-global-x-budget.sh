#!/usr/bin/env bash
set -euo pipefail
mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo GLOBAL_X_ROLLOUT_ARGS_INVALID; exit 2; }
: "${ANTE_UP_GLOBAL_X_RELEASE:?Set the tested image tag}"

release="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base=/srv/ante-up/builds/always-on-20261012/deploy
state=/srv/ante-up/builds/service-state
image="ante-up:${ANTE_UP_GLOBAL_X_RELEASE}"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT

compose_args() {
  local service="$1" variant="$2" file
  local files
  files="$(cat "$scratch/$service.files")"
  local -a list
  IFS=',' read -r -a list <<< "$files"
  args=(-p ante-up
    --env-file "$base/.env"
    --env-file "$base/evidence-budget.env"
    --env-file /srv/ante-up/builds/visitor-onboarding-174c8e4/visitor-sol.env)
  for file in "${list[@]}"; do args+=(-f "$file"); done
  if [[ "$variant" == new ]]; then
    if [[ "$service" == collector ]]; then
      args+=(-f "$release/deploy/compose.global-x-budget.yml")
    else
      args+=(-f "$release/deploy/compose.global-x-budget-tariff.yml")
    fi
  fi
}

for service in collector collector-tariff; do
  docker inspect "ante-up-$service-1" +    --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' +    > "$scratch/$service.files"
  compose_args "$service" old
  docker compose "${args[@]}" config --format json > "$scratch/$service.old.json"
  docker inspect "ante-up-$service-1" --format '{{.Config.Image}}' > "$scratch/$service.image"
  compose_args "$service" new
  docker compose "${args[@]}" config --format json > "$scratch/$service.new.json"
  python3 - "$scratch/$service.old.json" "$scratch/$service.new.json" "$scratch/$service.image" "$service" "$image" <<'PY'
import json,sys
with open(sys.argv[1]) as f: old=json.load(f)
with open(sys.argv[2]) as f: new=json.load(f)
with open(sys.argv[3]) as f: running=f.read().strip()
service,image=sys.argv[4:]
assert old['services'][service]['image']==running,(service,'RUNNING_IMAGE_MISMATCH')
assert new['services'][service]['image']==image
assert new['services'][service]['environment']['ANTE_UP_GLOBAL_X_BUDGET_DB']=='/state/global-x-budget.sqlite'
old['services'][service]['image']=image
old['services'][service]['environment']['ANTE_UP_GLOBAL_X_BUDGET_DB']='/state/global-x-budget.sqlite'
assert old==new,(service,'UNEXPECTED_COMPOSE_CHANGE')
print(service,'CONFIG_DIFF_IMAGE_AND_GLOBAL_BUDGET_PATH_ONLY')
PY
done

docker run --rm --user 1000:1000 -v "$state:/state:ro" "$image" +  node scripts/seed-global-x-budget.mjs --plan /state/global-x-budget.sqlite +  /state/live-smoke/collection.json /state/tariff/collection.json
[[ "$mode" == --apply ]] || exit 0
[[ ! -e "$state/global-x-budget.sqlite" ]] || { echo GLOBAL_X_BUDGET_ALREADY_INITIALIZED; exit 1; }

rollback() {
  echo GLOBAL_X_ROLLOUT_FAILED_ROLLING_BACK
  for service in collector collector-tariff; do
    compose_args "$service" old
    docker compose "${args[@]}" up -d --no-deps "$service" || true
  done
}
trap rollback ERR
docker stop -t 60 ante-up-collector-1 ante-up-collector-tariff-1 > /dev/null
docker run --rm --user 1000:1000 -v "$state:/state" "$image" +  node scripts/seed-global-x-budget.mjs --apply /state/global-x-budget.sqlite +  /state/live-smoke/collection.json /state/tariff/collection.json

for service in collector collector-tariff; do
  compose_args "$service" new
  docker compose "${args[@]}" up -d --no-deps "$service"
  health=unknown
  for i in $(seq 1 90); do
    health="$(docker inspect "ante-up-$service-1" --format '{{.State.Health.Status}}' 2>/dev/null || true)"
    [[ "$health" == healthy ]] && break
    sleep 2
  done
  [[ "$health" == healthy ]] || { echo "$service HEALTH_FAILED"; false; }
  [[ "$(docker inspect "ante-up-$service-1" --format '{{.Config.Image}}')" == "$image" ]]
  echo "$service HEALTHY_NEW_IMAGE"
done
trap - ERR
echo GLOBAL_X_ROLLOUT_COMPLETE
