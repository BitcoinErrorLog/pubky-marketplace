#!/usr/bin/env bash
# Decide whether the launch-e2e job runs.
#
# Fork pull requests do not receive repo secrets, so LAUNCH_E2E_SELLER_SECRET_HEX
# is empty there and the suite can never pass. Skip those with a notice.
# A same-repo pull request with the secret missing fails. It must not skip.
set -euo pipefail

secret="${LAUNCH_E2E_SELLER_SECRET_HEX:-}"
head_repo="${LAUNCH_E2E_HEAD_REPO:-}"
base_repo="${LAUNCH_E2E_BASE_REPO:-}"

emit() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s\n' "$1" >>"$GITHUB_OUTPUT"
  fi
}

if [[ -n "$secret" ]]; then
  emit "run=true"
  exit 0
fi

if [[ -n "$head_repo" && -n "$base_repo" && "$head_repo" != "$base_repo" ]]; then
  emit "run=false"
  echo "::notice title=launch-e2e skipped::Fork pull request from ${head_repo} does not receive LAUNCH_E2E_SELLER_SECRET_HEX. launch-e2e did not run. Same-repo pull requests still fail when this secret is missing."
  exit 0
fi

echo "::error title=launch-e2e::LAUNCH_E2E_SELLER_SECRET_HEX is missing. This same-repo pull request must run launch-e2e; the job does not skip."
exit 1
