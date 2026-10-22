#!/usr/bin/env bash
# Offline regression for a pinned Pi effort against Pi's actual model runtime.
# The fake provider is local config only: no credentials, catalog request, or
# model prompt is needed to distinguish a reasoning model that supports the
# extended levels from one Pi would clamp to high.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

fm_live_gate opt-in FM_PI_WORKER_EFFORT_E2E npm node pi

PI_BIN=${FM_PI_EFFORT_TEST_BIN:-$(type -P pi)}
PI_PACKAGE_DIR=${FM_PI_PACKAGE_DIR:-"$(npm root -g)/@earendil-works/pi-coding-agent"}
[ -f "$PI_PACKAGE_DIR/package.json" ] || fail "Pi SDK absent: set FM_PI_PACKAGE_DIR to the selected @earendil-works/pi-coding-agent package"

TMP_ROOT=$(fm_test_tmproot fm-pi-worker-effort)
agentdir="$TMP_ROOT/agent"
project="$TMP_ROOT/project"
mkdir -p "$agentdir" "$project"
cat > "$agentdir/models.json" <<'JSON'
{
  "providers": {
    "fm-live-fake": {
      "baseUrl": "http://127.0.0.1:9/v1",
      "api": "openai-completions",
      "apiKey": "fm-live-placeholder",
      "models": [
        {
          "id": "fm-live-deep",
          "name": "fm live deep",
          "contextWindow": 8192,
          "maxTokens": 512,
          "reasoning": true,
          "thinkingLevelMap": {
            "minimal": "minimal",
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "xhigh",
            "max": "max"
          }
        },
        {
          "id": "fm-live-shallow",
          "name": "fm live shallow",
          "contextWindow": 8192,
          "maxTokens": 512,
          "reasoning": true
        }
      ]
    }
  }
}
JSON

# shellcheck source=bin/fm-worker-effort-lib.sh
. "$ROOT/bin/fm-worker-effort-lib.sh"
export PI_PACKAGE_DIR PI_CODING_AGENT_DIR="$agentdir" PI_OFFLINE=1
for effort in xhigh max; do
  config="$TMP_ROOT/config-$effort"
  mkdir -p "$config"
  printf '%s\n' "$effort" > "$config/crew-effort"
  fm_worker_effort_validate_pi_capability \
    "$config" pi "$PI_BIN" fm-live-fake/fm-live-deep "$project" "$agentdir" "" "" 0 \
    || fail "Pi's actual model runtime rejected capable model at $effort"
  if fm_worker_effort_validate_pi_capability \
    "$config" pi "$PI_BIN" fm-live-fake/fm-live-shallow "$project" "$agentdir" "" "" 0; then
    fail "Pi's actual model runtime accepted the model it clamps below $effort"
  fi
done

[ "$(find "$agentdir" -maxdepth 1 -type f -printf '%f\n' | sort | tr '\n' ' ')" = "models.json " ] \
  || fail "Pi capability preflight wrote into the selected account directory"
pass "Pi's offline native runtime accepts supported xhigh/max and refuses models it would clamp"
