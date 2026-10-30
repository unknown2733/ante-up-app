#!/usr/bin/env bash
set -euo pipefail
mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo API_IMAGE_ARGS_INVALID; exit 2; }
: "${ANTE_UP_API_IMAGE_RELEASE:?Set reviewed API image tag}"
target_release="$ANTE_UP_API_IMAGE_RELEASE"
release="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="ante-up:${target_release}"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT

docker inspect ante-up-api-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' > "$scratch/files"
docker inspect ante-up-api-1 --format '{{index .Config.Labels "com.docker.compose.project.environment_file"}}' > "$scratch/env"
running_image="$(docker inspect ante-up-api-1 --format '{{.Config.Image}}')"
[[ "$running_image" == ante-up:* ]] || { echo API_RUNNING_IMAGE_UNEXPECTED; exit 1; }
IFS=',' read -r -a files < "$scratch/files"
IFS=',' read -r -a env_files < "$scratch/env"
args=(-p ante-up)
for file in "${env_files[@]}"; do args+=(--env-file "$file"); done
for file in "${files[@]}"; do args+=(-f "$file"); done
docker compose "${args[@]}" config --format json > "$scratch/old.json"
next=("${args[@]}" -f "$release/deploy/compose.api-image.yml")
ANTE_UP_API_IMAGE_RELEASE="$target_release" docker compose "${next[@]}" config --format json > "$scratch/new.json"
python3 - "$scratch/old.json" "$scratch/new.json" "$running_image" "$image" <<'PY'
import json,sys
with open(sys.argv[1]) as f: old=json.load(f)
with open(sys.argv[2]) as f: new=json.load(f)
running,image=sys.argv[3:]
assert old['services']['api']['image']==running,'RUNNING_IMAGE_MISMATCH'
assert new['services']['api']['image']==image,'NEW_IMAGE_MISMATCH'
old['services']['api']['image']=image
assert old==new,'UNEXPECTED_COMPOSE_CHANGE'
print('API_CONFIG_DIFF_IMAGE_ONLY')
PY
[[ "$mode" == --apply ]] || exit 0
rollback(){
  echo API_IMAGE_ROLLOUT_FAILED_ROLLING_BACK
  docker compose "${args[@]}" up -d --no-deps api || true
}
trap rollback ERR
ANTE_UP_API_IMAGE_RELEASE="$target_release" docker compose "${next[@]}" up -d --no-deps api
health=unknown
for i in $(seq 1 60); do
  health="$(docker inspect ante-up-api-1 --format '{{.State.Health.Status}}' 2>/dev/null || true)"
  [[ "$health" == healthy ]] && break
  sleep 2
done
[[ "$health" == healthy ]] || { echo API_IMAGE_HEALTH_FAILED; false; }
[[ "$(docker inspect ante-up-api-1 --format '{{.Config.Image}}')" == "$image" ]]
trap - ERR
echo API_IMAGE_ROLLOUT_COMPLETE
