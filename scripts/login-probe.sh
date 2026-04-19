#!/bin/bash
# Prod-gate login probe.
#
# Exercises the full credential round-trip against a Cloud Run revision
# before we promote it to serving traffic:
#
#   PUT  /credentials/<key>          ← store username/password in Secret Manager
#   POST /login/<slug>                ← run the marketplace login adapter
#   DELETE /credentials/<key>        ← cleanup (runs via trap on exit)
#
# Invoked from .github/workflows/browser-deploy.yml's `login-probe` job for
# the prod path. Dev path has no equivalent — the Maestro E2E it dispatches
# against integration-test exercises the same endpoints indirectly.
#
# Usage:
#   ./scripts/login-probe.sh <site> <username> <password> <login-slug>
#
#   site         - semantic name, used in the credential key. Currently
#                  "buysportscards" or "sportlots".
#   username     - marketplace username (passed in from GitHub Secrets).
#   password     - marketplace password (passed in from GitHub Secrets).
#   login-slug   - the /login/<slug> path suffix. Currently "bsc" or
#                  "sportlots".
#
# Required env:
#   TAGGED_URL        - the Cloud Run tagged revision URL to probe.
#   INTERNAL_API_KEY  - value of the `internal-api-key` secret.
#
# Exits non-zero on any non-2xx or on a `success: false` response body.
# The DELETE cleanup runs even on failure (via trap EXIT).

set -euo pipefail

SITE="$1"
USERNAME="$2"
PASSWORD="$3"
LOGIN_SLUG="$4"

: "${TAGGED_URL:?TAGGED_URL must be set}"
: "${INTERNAL_API_KEY:?INTERNAL_API_KEY must be set}"

SHORT_SHA="$(echo "${GITHUB_SHA:-local}" | cut -c1-7)"
KEY="probe-${LOGIN_SLUG}-${SHORT_SHA}"

echo "=== Login probe: ${LOGIN_SLUG} @ ${TAGGED_URL} ==="
echo "Credential key: ${KEY}"
echo "Site (for logs only): ${SITE}"

cleanup() {
  echo "→ DELETE /credentials/${KEY}"
  # Failing cleanup shouldn't mask an earlier real failure; the worst
  # outcome is a stale Secret Manager entry, which is harmless for a
  # one-shot probe key that has <SHA> in the name.
  curl -sS -o /tmp/probe-delete.out -w "  HTTP %{http_code}\n" \
    -X DELETE "${TAGGED_URL}/credentials/${KEY}" \
    -H "x-internal-key: ${INTERNAL_API_KEY}" || true
}
trap cleanup EXIT

# 1. Store credentials
echo "→ PUT /credentials/${KEY}"
PUT_BODY=$(jq -n --arg u "$USERNAME" --arg p "$PASSWORD" '{username:$u, password:$p}')
PUT_STATUS=$(curl -sS -o /tmp/probe-put.out -w "%{http_code}" \
  -X PUT "${TAGGED_URL}/credentials/${KEY}" \
  -H "Content-Type: application/json" \
  -H "x-internal-key: ${INTERNAL_API_KEY}" \
  -d "$PUT_BODY")
echo "  HTTP ${PUT_STATUS}"
if [ "$PUT_STATUS" != "200" ]; then
  echo "PUT failed. Response:"
  cat /tmp/probe-put.out
  echo
  exit 1
fi

# 2. Trigger marketplace login
echo "→ POST /login/${LOGIN_SLUG}"
LOGIN_BODY=$(jq -n --arg k "$KEY" '{key:$k}')
LOGIN_STATUS=$(curl -sS -o /tmp/probe-login.out -w "%{http_code}" \
  -X POST "${TAGGED_URL}/login/${LOGIN_SLUG}" \
  -H "Content-Type: application/json" \
  -H "x-internal-key: ${INTERNAL_API_KEY}" \
  --max-time 90 \
  -d "$LOGIN_BODY")
echo "  HTTP ${LOGIN_STATUS}"
if [ "$LOGIN_STATUS" != "200" ]; then
  echo "Login failed. Response:"
  cat /tmp/probe-login.out
  echo
  exit 1
fi

# 3. Response body must say success:true (adapter could return 200 with a
# soft-failure body, which happened before the refactor).
if ! jq -e '.success == true' /tmp/probe-login.out >/dev/null 2>&1; then
  echo "Login response body did not indicate success:"
  cat /tmp/probe-login.out
  echo
  exit 1
fi

echo "✓ ${LOGIN_SLUG} login probe passed"
