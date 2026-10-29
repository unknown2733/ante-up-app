#!/usr/bin/env bash
set -euo pipefail
config="${1:?Pass the staged ops monitor configuration path}"
[[ -f "$config" ]] || { echo OPS_CONFIG_MISSING; exit 2; }
backup="$config.pre-active-storage-20261030"
[[ ! -e "$backup" ]] || { echo OPS_CONFIG_BACKUP_EXISTS; exit 2; }
tmp="$config.tmp.$$"
trap 'rm -f -- "$tmp"' EXIT
cp -p -- "$config" "$backup"
jq --argjson limit 5368709120 '
  .activeStorage = [
    {name:"chips-and-solana",path:"live-smoke",limitBytes:$limit},
    {name:"tariff",path:"tariff",limitBytes:$limit}
  ]' "$config" > "$tmp"
jq -e '.activeStorage | length == 2' "$tmp" >/dev/null
chmod --reference="$config" "$tmp"
mv -- "$tmp" "$config"
echo OPS_ACTIVE_STORAGE_CONFIGURED
