#!/usr/bin/env bash
set -euo pipefail
mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo OPS_GLOBAL_X_ARGS_INVALID; exit 2; }
: "${ANTE_UP_OPS_GLOBAL_X_RELEASE:?Set the tested ops image tag}"
release="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="ante-up-ops:${ANTE_UP_OPS_GLOBAL_X_RELEASE}"
service=ops-monitor
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT

docker inspect ante-up-ops-monitor-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' > "$scratch/files"
docker inspect ante-up-ops-monitor-1 --format '{{index .Config.Labels "com.docker.compose.project.environment_file"}}' > "$scratch/env"
docker inspect ante-up-ops-monitor-1 --format '{{.Config.Image}}' > "$scratch/image"
running_image="$(cat "$scratch/image")"
[[ "$running_image" == ante-up-ops:* ]] || { echo OPS_RUNNING_IMAGE_INVALID; exit 2; }
old_release="${running_image#ante-up-ops:}"
IFS=',' read -r -a files < "$scratch/files"
IFS=',' read -r -a env_files < "$scratch/env"
args=(-p ante-up --profile ops)
for file in "${env_files[@]}"; do args+=(--env-file "$file"); done
for file in "${files[@]}"; do args+=(-f "$file"); done
ANTE_UP_OPS_GLOBAL_X_RELEASE="$old_release" docker compose "${args[@]}" config --format json > "$scratch/old.json"
next=("${args[@]}" -f "$release/deploy/compose.ops-global-x.yml")
docker compose "${next[@]}" config --format json > "$scratch/new.json"
python3 - "$scratch/old.json" "$scratch/new.json" "$scratch/image" "$image" <<'PY'
import json,sys
with open(sys.argv[1]) as f: old=json.load(f)
with open(sys.argv[2]) as f: new=json.load(f)
with open(sys.argv[3]) as f: running=f.read().strip()
image=sys.argv[4]
a=old['services']['ops-monitor']
b=new['services']['ops-monitor']
assert a['image']==running,'RUNNING_IMAGE_MISMATCH'
assert b['image']==image
assert '/ops-config/monitor.global-x.json' in b['command']
assert '/ops-config/monitor.global-x.json' in b['healthcheck']['test']
a['image']=image
a['command']=b['command']
a['healthcheck']['test']=b['healthcheck']['test']
assert old==new,'UNEXPECTED_COMPOSE_CHANGE'
print('OPS_CONFIG_DIFF_IMAGE_AND_CONFIG_PATH_ONLY')
PY
[[ "$mode" == --apply ]] || exit 0
rollback() {
  echo OPS_GLOBAL_X_ROLLOUT_FAILED_ROLLING_BACK
  ANTE_UP_OPS_GLOBAL_X_RELEASE="$old_release" docker compose "${args[@]}" up -d --no-deps "$service" || true
}
trap rollback ERR
docker compose "${next[@]}" up -d --no-deps "$service"
health=unknown
for i in $(seq 1 60); do
  health="$(docker inspect ante-up-ops-monitor-1 --format '{{.State.Health.Status}}' 2>/dev/null || true)"
  [[ "$health" == healthy ]] && break
  sleep 2
done
[[ "$health" == healthy ]] || { echo OPS_GLOBAL_X_HEALTH_FAILED; false; }
[[ "$(docker inspect ante-up-ops-monitor-1 --format '{{.Config.Image}}')" == "$image" ]]
trap - ERR
echo OPS_GLOBAL_X_ROLLOUT_COMPLETE
