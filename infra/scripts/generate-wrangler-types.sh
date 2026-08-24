#!/usr/bin/env bash
set -euo pipefail

readonly root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

while IFS= read -r config; do
  directory="$(dirname "$config")"
  pnpm exec wrangler types "$directory/worker-configuration.d.ts" --config "$config"
done < <(
  printf '%s\n' 'infra/cloudflare/wrangler.template.jsonc'
  find apps workers -name wrangler.jsonc -type f -print | sort
)

# Keep the historical root declaration truthful until it can be removed in a
# dedicated compatibility change. It is generated from the Queue consumer
# config, not hand-maintained.
pnpm exec wrangler types worker-configuration.d.ts --config workers/queue-consumers/wrangler.jsonc
