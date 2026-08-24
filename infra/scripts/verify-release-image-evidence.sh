#!/usr/bin/env bash

# Verify the protected Node image evidence that a release is allowed to cite.
# This is intentionally invoked immediately before, and again immediately after,
# the production environment approval boundary. A workflow conclusion alone is
# not evidence: source validation may pass while the protected build is skipped.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN with Actions read permission is required}"
: "${REPOSITORY:?REPOSITORY is required}"
: "${TAG_SHA:?TAG_SHA is required}"

max_attempts=${GRIDORA_RELEASE_EVIDENCE_MAX_ATTEMPTS:-60}
poll_seconds=${GRIDORA_RELEASE_EVIDENCE_POLL_SECONDS:-15}
[[ "$max_attempts" =~ ^[1-9][0-9]*$ ]]
[[ "$poll_seconds" =~ ^[0-9]+$ ]]

require_successful_image_build() {
  local runs run run_id run_attempt jobs artifacts artifact_name url

  for attempt in $(seq 1 "$max_attempts"); do
    runs=$(gh api --paginate --slurp --method GET \
      "repos/$REPOSITORY/actions/workflows/image.yml/runs" \
      -f head_sha="$TAG_SHA" \
      -f per_page=100)

    while IFS= read -r run; do
      [[ -n "$run" ]] || continue
      run_id=$(jq -r '.id' <<<"$run")
      run_attempt=$(jq -r '.run_attempt' <<<"$run")
      url=$(jq -r '.html_url' <<<"$run")
      [[ "$run_id" =~ ^[1-9][0-9]*$ ]]
      [[ "$run_attempt" =~ ^[1-9][0-9]*$ ]]

      # This endpoint is intentionally scoped to the selected run attempt.
      # A later rerun must not inherit named-job success from an earlier attempt.
      jobs=$(gh api --paginate --slurp --method GET \
        "repos/$REPOSITORY/actions/runs/$run_id/attempts/$run_attempt/jobs" \
        -f per_page=100)
      if ! jq -e '
        [.[].jobs[]]
        | any(.name == "validate" and .status == "completed" and .conclusion == "success") and
          any(.name == "build-local" and .status == "completed" and .conclusion == "success") and
          any(.name == "provider-image-smoke" and .status == "completed" and .conclusion == "success")
      ' <<<"$jobs" >/dev/null; then
        continue
      fi

      artifact_name="gridora-node-${run_id}-${run_attempt}"
      artifacts=$(gh api --paginate --slurp --method GET \
        "repos/$REPOSITORY/actions/runs/$run_id/artifacts" \
        -f per_page=100)
      if jq -e \
        --arg name "$artifact_name" \
        --arg sha "$TAG_SHA" \
        --argjson run_id "$run_id" '
          [.[].artifacts[]]
          | any(
              .name == $name and
              .expired == false and
              (.size_in_bytes | type == "number" and . > 0) and
              .workflow_run.id == $run_id and
              .workflow_run.head_branch == "main" and
              .workflow_run.head_sha == $sha
            )
        ' <<<"$artifacts" >/dev/null; then
        printf 'Protected Node image build evidence passed for %s: %s\n' "$TAG_SHA" "$url"
        return 0
      fi
    done < <(jq -c --arg sha "$TAG_SHA" '
      [.[].workflow_runs[]]
      | map(select(
          .head_sha == $sha and
          .event == "workflow_dispatch" and
          .head_branch == "main" and
          .status == "completed" and
          .conclusion == "success" and
          (.run_attempt | type == "number" and . >= 1)
        ))
      | sort_by(.run_attempt, .created_at)
      | reverse
      | .[]
    ' <<<"$runs")

    if (( attempt == max_attempts )); then
      printf 'No successful protected Node image run-attempt artifact exists for %s.\n' "$TAG_SHA" >&2
      return 1
    fi
    sleep "$poll_seconds"
  done
}

require_successful_image_build
