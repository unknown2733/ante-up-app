#!/usr/bin/env bash
set -euo pipefail
mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo WEB_ASSETS_ARGS_INVALID; exit 2; }
: "${ANTE_UP_WEB_ASSETS_RELEASE:?Set reviewed web assets image tag}"
release="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="ante-up:${ANTE_UP_WEB_ASSETS_RELEASE}"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT

docker inspect ante-up-web-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' > "$scratch/files"
docker inspect ante-up-web-1 --format '{{index .Config.Labels "com.docker.compose.project.environment_file"}}' > "$scratch/env"
docker inspect ante-up-web-1 --format '{{.Config.Image}}' > "$scratch/image"
running_image="$(cat "$scratch/image")"
IFS=',' read -r -a files < "$scratch/files"
IFS=',' read -r -a env_files < "$scratch/env"
args=(-p ante-up)
for file in "${env_files[@]}"; do args+=(--env-file "$file"); done
# Older web rollouts supplied the visitor faucet limits in the shell instead of
# retaining that env file in the container's Compose label.
visitor_env=/srv/ante-up/builds/visitor-onboarding-174c8e4/visitor-sol.env
[[ -f "$visitor_env" ]] && args+=(--env-file "$visitor_env")
for file in "${files[@]}"; do args+=(-f "$file"); done
docker compose "${args[@]}" config --format json > "$scratch/old.json"
next=("${args[@]}" -f "$release/deploy/compose.web-assets.yml")
docker compose "${next[@]}" config --format json > "$scratch/new.json"
python3 - "$scratch/old.json" "$scratch/new.json" "$running_image" "$image" <<'PY'
import json,sys
with open(sys.argv[1]) as f: old=json.load(f)
with open(sys.argv[2]) as f: new=json.load(f)
running,image=sys.argv[3:]
a=old['services']['web'];b=new['services']['web']
assert a['image']==running,'RUNNING_IMAGE_MISMATCH'
assert b['image']==image,'NEW_IMAGE_MISMATCH'
a['image']=image
assert old==new,'UNEXPECTED_COMPOSE_CHANGE'
print('WEB_CONFIG_DIFF_IMAGE_ONLY')
PY
[[ "$mode" == --apply ]] || exit 0
rollback(){
  echo WEB_ASSETS_ROLLOUT_FAILED_ROLLING_BACK
  docker compose "${args[@]}" up -d --no-deps web || true
}
trap rollback ERR
docker compose "${next[@]}" up -d --no-deps web
health=unknown
for i in $(seq 1 60); do
  health="$(docker inspect ante-up-web-1 --format '{{.State.Health.Status}}' 2>/dev/null || true)"
  [[ "$health" == healthy ]] && break
  sleep 2
done
[[ "$health" == healthy ]] || { echo WEB_ASSETS_HEALTH_FAILED; false; }
[[ "$(docker inspect ante-up-web-1 --format '{{.Config.Image}}')" == "$image" ]]
trap - ERR
echo WEB_ASSETS_ROLLOUT_COMPLETE
