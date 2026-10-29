#!/usr/bin/env bash
set -euo pipefail
mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo COLLECTOR_SCHEDULE_ARGS_INVALID; exit 2; }
: "${ANTE_UP_COLLECTOR_SCHEDULE_RELEASE:?Set the tested image tag}"
image="ante-up:${ANTE_UP_COLLECTOR_SCHEDULE_RELEASE}"
base=/srv/ante-up/builds/always-on-20261012/deploy
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT

compose_args() {
  local service="$1" variant="$2" file
  local -a files
  IFS=',' read -r -a files < "$scratch/$service.files"
  args=(-p ante-up --env-file "$base/.env"
    --env-file "$base/evidence-budget.env"
    --env-file /srv/ante-up/builds/visitor-onboarding-174c8e4/visitor-sol.env)
  for file in "${files[@]}"; do
    if [[ ! -f "$file" ]]; then
      [[ "$file" == /tmp/tmp.*/collector*.new.yml ]] || { echo COLLECTOR_COMPOSE_FILE_MISSING; exit 1; }
      continue
    fi
    args+=(-f "$file")
  done
  [[ "$variant" == old ]] || args+=(-f "$scratch/$service.$variant.yml")
}

for service in collector collector-tariff; do
  docker inspect "ante-up-$service-1" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' > "$scratch/$service.files"
  docker inspect "ante-up-$service-1" --format '{{.Config.Image}}' > "$scratch/$service.image"
  printf 'services:\n  %s:\n    image: %s\n' "$service" "$image" > "$scratch/$service.new.yml"
  printf 'services:\n  %s:\n    image: %s\n' "$service" "$(cat "$scratch/$service.image")" > "$scratch/$service.rollback.yml"
  compose_args "$service" old
  docker compose "${args[@]}" config --format json > "$scratch/$service.old.json"
  compose_args "$service" new
  docker compose "${args[@]}" config --format json > "$scratch/$service.new.json"
  python3 - "$scratch/$service.old.json" "$scratch/$service.new.json" "$service" "$image" <<'PY'
import json,sys
old=json.load(open(sys.argv[1]));new=json.load(open(sys.argv[2]))
service,image=sys.argv[3:]
assert new['services'][service]['image']==image
old['services'][service]['image']=image
assert old==new,(service,'UNEXPECTED_COMPOSE_CHANGE')
print(service,'CONFIG_DIFF_IMAGE_ONLY')
PY
done
[[ "$mode" == --apply ]] || exit 0

rollback() {
  echo COLLECTOR_SCHEDULE_ROLLBACK
  for service in collector collector-tariff; do
    compose_args "$service" rollback
    docker compose "${args[@]}" up -d --no-deps "$service" || true
  done
}
trap rollback ERR
for service in collector collector-tariff; do
  compose_args "$service" new
  docker compose "${args[@]}" up -d --no-deps "$service"
  health=unknown
  for _ in $(seq 1 60); do
    health="$(docker inspect "ante-up-$service-1" --format '{{.State.Health.Status}}' 2>/dev/null || true)"
    [[ "$health" == healthy ]] && break
    sleep 2
  done
  [[ "$health" == healthy ]] || { echo "$service HEALTH_FAILED"; false; }
  [[ "$(docker inspect "ante-up-$service-1" --format '{{.Config.Image}}')" == "$image" ]]
  echo "$service HEALTHY_NEW_IMAGE"
done
trap - ERR
echo COLLECTOR_SCHEDULE_ROLLOUT_COMPLETE
