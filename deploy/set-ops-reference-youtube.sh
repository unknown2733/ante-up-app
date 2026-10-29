#!/usr/bin/env bash
set -euo pipefail
config="${1:?Pass the staged ops monitor configuration path}"
[[ -f "$config" ]] || { echo OPS_CONFIG_MISSING; exit 2; }
backup="$config.pre-reference-youtube-20261030"
[[ ! -e "$backup" ]] || { echo OPS_CONFIG_BACKUP_EXISTS; exit 2; }
tmp="$config.tmp.$$"
trap 'rm -f -- "$tmp"' EXIT
cp -p -- "$config" "$backup"
jq '.referenceYouTube = {ledgerPath:"live-smoke/index.sqlite",maxAgeSeconds:900}' "$config" > "$tmp"
jq -e '.referenceYouTube.ledgerPath == "live-smoke/index.sqlite" and .referenceYouTube.maxAgeSeconds == 900' "$tmp" >/dev/null
chmod --reference="$config" "$tmp"
mv -- "$tmp" "$config"
echo OPS_REFERENCE_YOUTUBE_CONFIGURED
