#!/usr/bin/env bash
# Upload a zip to the Chrome Web Store and submit it for review.
#
#   chrome-web-store.sh <zip>
#
# Needs: CWS_TOKEN (OAuth access token, scope chromewebstore),
#        CWS_PUBLISHER_ID, CWS_EXTENSION_ID.
# Uses Chrome Web Store API v2.
set -euo pipefail

zip="${1:?usage: chrome-web-store.sh <zip>}"
: "${CWS_TOKEN:?}" "${CWS_PUBLISHER_ID:?}" "${CWS_EXTENSION_ID:?}"

item="publishers/${CWS_PUBLISHER_ID}/items/${CWS_EXTENSION_ID}"
api="https://chromewebstore.googleapis.com"
auth=(-H "Authorization: Bearer ${CWS_TOKEN}")

# Print the body on success; on an HTTP error send it to the log and fail.
call() {
  local out code
  out="$(mktemp)"
  code="$(curl -sS -o "$out" -w '%{http_code}' "${auth[@]}" "$@")"
  if [[ "$code" =~ ^2 ]]; then
    cat "$out"
    rm -f "$out"
  else
    echo "HTTP $code from $*" >&2
    cat "$out" >&2
    rm -f "$out"
    return 1
  fi
}

echo "Uploading $zip"
upload="$(call -X POST -T "$zip" "${api}/upload/v2/${item}:upload")"
echo "$upload"
state="$(jq -r '.uploadState // empty' <<<"$upload")"

# Large packages are processed in the background; wait for them.
for _ in $(seq 1 30); do
  [[ "$state" == *IN_PROGRESS* ]] || break
  sleep 10
  status="$(call "${api}/v2/${item}:fetchStatus")"
  state="$(jq -r '.lastAsyncUploadState // empty' <<<"$status")"
  echo "upload state: $state"
done

if [[ "$state" != "SUCCEEDED" ]]; then
  echo "Upload did not succeed (state: ${state:-unknown})." >&2
  exit 1
fi

echo "Submitting for review"
publish="$(call -X POST -H "Content-Type: application/json" \
  -d '{"publishType":"DEFAULT_PUBLISH"}' "${api}/v2/${item}:publish")"
echo "$publish"
echo "Submitted. State: $(jq -r '.state // "unknown"' <<<"$publish"). It goes live once Google's review passes."
