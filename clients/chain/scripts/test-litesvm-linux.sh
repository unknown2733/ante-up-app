#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if ! command -v cargo-build-sbf >/dev/null 2>&1; then
  echo 'cargo-build-sbf is required from an existing official Solana/Agave toolchain.' >&2
  exit 2
fi
if ! command -v npm >/dev/null 2>&1; then
  echo 'npm is required.' >&2
  exit 2
fi

cd "$repo_root"
cargo build-sbf --manifest-path programs/ante_up/Cargo.toml --tools-version v1.54 --arch v3
sbf_path="$repo_root/target/deploy/ante_up.so"
if [[ ! -s "$sbf_path" ]]; then
  echo "SBF binary was not produced: $sbf_path" >&2
  exit 2
fi
export ANTE_UP_SBF_PATH="$sbf_path"
cd "$repo_root/clients/chain"
npm ci
npm test
