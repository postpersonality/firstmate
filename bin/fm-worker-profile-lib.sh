#!/usr/bin/env bash
# fm-worker-profile-lib.sh - the opt-in allowed worker-profile guard: the
# single owner of deciding whether one resolved crewmate or scout launch
# matches a home's declared worker profiles.
#
# docs/configuration.md "Worker profile guard (worker_profiles.allowed)" owns the
# operator contract and the file format; this library owns only the decision.
# Sourced by bin/fm-spawn.sh and bin/fm-control.sh.
#
# The policy lives in the home's existing config/crew-dispatch.json, so it needs
# no second parser and no second configuration file:
#   {"worker_profiles": {"allowed": [{"harness": ..., "model": ..., "effort": ...}]}}
# The block's PRESENCE is the opt-in. An absent block, or an absent file, leaves
# every launch exactly as it was: the caller gets its own inputs back unchanged.
#
# Presence means enforcement, never "policy absence": a malformed block, a
# missing or empty allowed list, an allowed profile missing an axis, a duplicate
# profile, or a configured rule/default profile that is not allowed all refuse
# the launch with an actionable error. Nothing falls back to a runtime's own
# default, and nothing silently selects another profile.
#
# Matching is EXACT on all three axes. A model or effort the caller left
# unspecified ("", "default") never matches, because accepting it would let the
# runtime pick its own default - exactly the primary-model inheritance this
# guard exists to stop. The harness name alone is therefore never a boundary: a
# Codex-backed model behind the pi harness is a different model string and is
# refused.
#
# A raw launch command cannot be verified, so it is refused while the block is
# present, exactly as the effort pin already refuses one.
#
# The declared profile effort must also be natively applicable by that harness:
# the match is refused when bin/fm-worker-effort-lib.sh has no native fragment
# for it, rather than recording a level the launch would silently drop.
#
# jq is the parser, and config/crew-dispatch.json already requires it whenever
# the file exists (bin/fm-bootstrap.sh reports a missing jq). Without jq a
# launch still passes through when the file never mentions worker_profiles, and
# is refused when the text does: the word cannot appear without the block.

_FM_WORKER_PROFILE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=bin/fm-worker-effort-lib.sh
. "$_FM_WORKER_PROFILE_LIB_DIR/fm-worker-effort-lib.sh"

# fm_worker_profile_guard_resolve <config-dir> <harness> <model> <effort> <raw 0|1>
#   Print "<harness>\t<model>\t<effort>\t<pin-override>" on stdout:
#     - the inputs verbatim with an empty override when no policy is configured;
#     - the matched allowed profile with its optional effort_pin_override when
#       one matches, which the caller passes to fm_worker_effort_apply so a
#       declared standing exception is applied BEFORE the pin rejects the level.
#   Return non-zero with an actionable error on stderr for every refusal.
fm_worker_profile_guard_resolve() {
  local config=$1 harness=$2 model=$3 effort=$4 raw=$5
  local file out status field1 field2 field3 field4 jq_prog
  file=$config/crew-dispatch.json

  # No dispatch file at all: no policy exists to enforce.
  if [ ! -e "$file" ] && [ ! -L "$file" ]; then
    printf '%s\t%s\t%s\t\n' "$harness" "$model" "$effort"
    return 0
  fi
  if [ ! -f "$file" ] || [ ! -r "$file" ]; then
    echo "error: config/crew-dispatch.json is not a readable regular file, so its worker_profiles policy cannot be verified; refusing the launch rather than treating an unreadable policy as absent" >&2
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    if grep -q 'worker_profiles' "$file" 2>/dev/null; then
      echo "error: config/crew-dispatch.json declares worker_profiles, but jq is not installed to validate it; install jq before launching a worker from this home" >&2
      return 1
    fi
    printf '%s\t%s\t%s\t\n' "$harness" "$model" "$effort"
    return 0
  fi

  read -r -d '' jq_prog <<'JQ' || true
def profiles($v):
  if ($v | type) == "array" then $v
  elif ($v | type) == "object" then [$v]
  else [] end;
def tuple: {h: .harness, m: .model, e: .effort};
def used_profiles:
  ([(.rules // [])[]? | profiles(.use?)[]?]
   + (if has("default") then [profiles(.default)[]?] else [] end));
def allowed_objects:
  [(.worker_profiles.allowed // [])[]? | select(type == "object")];
def config_error:
  if (.worker_profiles | type) != "object" then "worker_profiles must be an object"
  elif (.worker_profiles | has("allowed") | not) then "worker_profiles needs an allowed list"
  elif (.worker_profiles.allowed | type) != "array" then "worker_profiles.allowed must be an array"
  elif (.worker_profiles.allowed | length) == 0 then "worker_profiles.allowed needs at least one profile"
  elif ([.worker_profiles.allowed[]? | select(type != "object")] | length) > 0 then "each allowed profile must be an object"
  elif ([allowed_objects[] | select(((.harness? | type) != "string") or (.harness | length) == 0 or ((.model? | type) != "string") or (.model | length) == 0 or ((.effort? | type) != "string") or (.effort | length) == 0)] | length) > 0 then "each allowed profile needs a non-empty harness, model, and effort"
  elif ([allowed_objects[] | select(has("effort_pin_override") and (((.effort_pin_override | type) != "string") or (.effort_pin_override != .effort)))] | length) > 0 then "an allowed effort_pin_override must equal that profile's effort"
  elif ([allowed_objects[] | tuple] | length) != ([allowed_objects[] | tuple] | unique | length) then "worker_profiles.allowed repeats a profile"
  else
    ([allowed_objects[] | tuple]) as $allowed
    | ([used_profiles[] | select(type == "object") | tuple] | map(select(. as $t | ($allowed | index($t)) == null)))
    | if length > 0 then "a configured rule or default profile is not in worker_profiles.allowed" else "" end
  end;
. as $doc
| if ($doc | has("worker_profiles") | not) then "inactive\t\t\t"
  else
    ($doc | config_error) as $err
    | if ($err | length) > 0 then "error\t\($err)\t\t"
      else
        [$doc | allowed_objects[] | select(.harness == $harness and .model == $model and .effort == $effort)] as $matches
        | if $matches | length == 0 then
            "refused\tnot an allowed worker profile\t\($harness)/\($model)/\($effort)\t\([$doc | allowed_objects[] | "\(.harness)/\(.model)/\(.effort)"] | join(", "))"
          else
            ($matches[0]) as $p
            | "ok\t\($p.harness)\t\($p.model)\t\($p.effort)\t\($p.effort_pin_override // "")"
          end
      end
  end
JQ

  if ! out=$(jq -r --arg harness "$harness" --arg model "$model" --arg effort "$effort" \
    "$jq_prog" "$file" 2>&1); then
    printf 'error: cannot read the worker_profiles policy from config/crew-dispatch.json: %s\n' "$out" >&2
    return 1
  fi
  IFS=$'\t' read -r status field1 field2 field3 field4 <<EOF
$out
EOF
  # A raw command cannot be verified against the declared profiles, so it is
  # refused while the policy is active, exactly as the effort pin refuses one.
  if [ "$raw" = 1 ] && [ "$status" != inactive ]; then
    echo "error: config/crew-dispatch.json declares the allowed worker profiles, so a raw launch command cannot be verified against them; launch an allowed profile with --harness, --model, and --effort" >&2
    return 1
  fi

  case "$status" in
  inactive)
    printf '%s\t%s\t%s\t\n' "$harness" "$model" "$effort"
    return 0
    ;;
  error)
    printf 'error: config/crew-dispatch.json worker_profiles is invalid - %s; fix it rather than launching outside the declared worker profiles\n' "$field1" >&2
    return 1
    ;;
  refused)
    printf 'error: %s/%s/%s is not an allowed worker profile for this home; allowed: %s (from config/crew-dispatch.json worker_profiles.allowed)\n' \
      "$harness" "$model" "$effort" "$field3" >&2
    return 1
    ;;
  esac

  # The matched profile's level must actually reach the runtime's own setting.
  if [ -z "$(fm_effort_flag_for_harness "$field1" "$field3" "$field2")" ]; then
    printf 'error: the allowed worker profile %s/%s/%s has no verified native effort setting, so this launch is refused rather than running at the runtime default\n' \
      "$field1" "$field2" "$field3" >&2
    return 1
  fi
  printf '%s\t%s\t%s\t%s\n' "$field1" "$field2" "$field3" "$field4"
}
