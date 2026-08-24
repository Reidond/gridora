#!/usr/bin/env bash
set -euo pipefail

readonly root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

while IFS= read -r config; do
  directory="$(dirname "$config")"
  declaration="$directory/worker-configuration.d.ts"
  if [[ ! -f "$declaration" ]]; then
    printf 'Missing generated Worker declaration: %s\n' "$declaration" >&2
    exit 1
  fi
  pnpm exec wrangler types "$declaration" --check --config "$config"
done < <(
  printf '%s\n' 'infra/cloudflare/wrangler.template.jsonc'
  find apps workers -name wrangler.jsonc -type f -print | sort
)

if [[ ! -f worker-configuration.d.ts ]]; then
  printf '%s\n' 'Missing legacy generated Worker declaration: worker-configuration.d.ts' >&2
  exit 1
fi
pnpm exec wrangler types worker-configuration.d.ts --check --config workers/queue-consumers/wrangler.jsonc
