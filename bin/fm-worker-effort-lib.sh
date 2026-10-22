#!/usr/bin/env bash
# fm-worker-effort-lib.sh - native effort flags and the optional
# config/crew-effort pin, sourced by bin/fm-spawn.sh, bin/fm-control.sh, and
# bin/fm-remote-secondmate-relaunch.sh.
#
# docs/configuration.md "Worker effort pin" owns the file format and operator
# contract; bin/fm-spawn.sh's header owns the rest of the launch mechanics.

_FM_WORKER_EFFORT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=bin/fm-timeout-lib.sh
. "$_FM_WORKER_EFFORT_LIB_DIR/fm-timeout-lib.sh"

_fm_worker_effort_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

# fm_effort_flag_for_harness <harness> <effort> [model]: print the native launch
# fragment that carries <effort>, or nothing when the adapter has no verified
# way to apply it (the effort is then recorded but omitted).
fm_effort_flag_for_harness() {
  local harness=$1 effort=$2 model=${3:-}
  [ -n "$effort" ] && [ "$effort" != default ] || return 0
  case "$harness" in
  dsh)
    # Preserve DSH's unpinned bridge request. Its model-specific support is
    # reported only after ACP session setup, so strict pins refuse separately.
    printf -- '--effort %s ' "$(_fm_worker_effort_quote "$effort")"
    ;;
  claude)
    case "$effort" in
    low | medium | high | xhigh | max) printf -- '--effort %s ' "$(_fm_worker_effort_quote "$effort")" ;;
    esac
    ;;
  codex)
    # The installed codex config schema uses model_reasoning_effort. The
    # installed model catalog supports max for gpt-5.6-luna; keep that level
    # scoped to the model whose catalog entry advertises it.
    case "$effort" in
    low | medium | high | xhigh) printf -- '-c %s ' "$(_fm_worker_effort_quote "model_reasoning_effort=\"$effort\"")" ;;
    max)
      [ "$model" = gpt-5.6-luna ] || return 0
      printf -- '-c %s ' "$(_fm_worker_effort_quote 'model_reasoning_effort="max"')"
      ;;
    esac
    ;;
  grok)
    # grok exposes both --effort and --reasoning-effort; firstmate's profile
    # axis is the reasoning knob. As of grok 0.2.99, --reasoning-effort accepts
    # only low|medium|high and rejects both xhigh and max, so omit those rather
    # than passing a known-bad value.
    case "$effort" in
    low | medium | high) printf -- '--reasoning-effort %s ' "$(_fm_worker_effort_quote "$effort")" ;;
    esac
    ;;
  agy)
    # agy 1.2.0 --effort accepts exactly low|medium|high, so xhigh and max are
    # omitted rather than passed as known-bad values (record-and-omit).
    case "$effort" in
    low | medium | high) printf -- '--effort %s ' "$(_fm_worker_effort_quote "$effort")" ;;
    esac
    ;;
  pi | pi-signed)
    # Pi 0.80.6 accepts the full shared effort vocabulary, including max, through
    # its --thinking flag.
    case "$effort" in
    ultra)
      "$_FM_WORKER_EFFORT_LIB_DIR/fm-harness.sh" validate-native-effort "$harness" "$model" "$effort" || return 1
      printf -- '--codex-effort %s ' "$(_fm_worker_effort_quote ultra)"
      ;;
    low | medium | high | xhigh | max) printf -- '--thinking %s ' "$(_fm_worker_effort_quote "$effort")" ;;
    esac
    ;;
  omp)
    # omp 18.1.11 --thinking accepts off|minimal|low|medium|high|xhigh|max|auto,
    # a superset of the shared vocabulary, so every level maps straight across.
    case "$effort" in
    low | medium | high | xhigh | max) printf -- '--thinking %s ' "$(_fm_worker_effort_quote "$effort")" ;;
    esac
    ;;
  opencode)
    # opencode's interactive `opencode --prompt` launch has no effort flag
    # (`opencode run --variant` is a different, non-interactive mode). Its
    # config schema (opencode 1.18.32, `opencode debug config` / config.json)
    # carries per-model reasoning effort as agent.<name>.variant, "Default model
    # variant for this agent (applies only when using the agent's configured
    # model)", so the effort rides the OPENCODE_CONFIG_CONTENT JSON the launch
    # already writes: the default build agent is pinned to the resolved model
    # and the effort named as its variant, which OpenCode resolves against that
    # model's own variant list. Those lists are per-provider (anthropic/* expose
    # high|max, openai/* expose low|medium|high|xhigh), so emit the variant only
    # when the resolved model's provider is known to expose that effort; any
    # other provider, or an effort outside its family's list, keeps the
    # permission-only launch and omits the variant (record-and-omit, as codex
    # and grok do). Without a resolved model the variant has nothing to key to
    # and is likewise omitted. The fragment lands inside the launch's
    # single-quoted assignment, so a literal quote in the model id must close and
    # reopen that quoting.
    [ -n "$model" ] && [ "$model" != default ] || return 0
    case "${model%%/*}:$effort" in
    anthropic:high | anthropic:max) ;;
    openai:low | openai:medium | openai:high | openai:xhigh) ;;
    *) return 0 ;;
    esac
    local model_json
    model_json=$(printf '%s' "$model" | sed 's/\\/\\\\/g; s/"/\\"/g')
    model_json=${model_json//\'/\'\\\'\'}
    printf ',"agent":{"build":{"model":"%s","variant":"%s"}}' "$model_json" "$effort"
    ;;
  muse)
    # muse 0.1.0-R708.1 --reasoning-effort accepts none|minimal|low|medium|
    # high|xhigh|ultra and defaults to high, so low..xhigh map straight across.
    # ultra is muse's max-CLASS level, so firstmate's max maps onto it - but
    # only ever as an EXPLICIT captain choice, never as a fallback, because
    # AGENTS.md section 4 forbids selecting max without captain preference and
    # the omitted effort here leaves muse on its own high default. muse's extra
    # none/minimal levels sit below firstmate's shared vocabulary and are
    # deliberately unreachable rather than remapped onto low.
    case "$effort" in
    low | medium | high | xhigh) printf -- '--reasoning-effort %s ' "$(_fm_worker_effort_quote "$effort")" ;;
    max) printf -- '--reasoning-effort %s ' "$(_fm_worker_effort_quote ultra)" ;;
    esac
    ;;
    # rovo has no --effort flag on `run`; its effort mapping rides
    # --config-override, but that flag is single-value (see bin/fm-spawn.sh's
    # rovo_config_override_flag) so it is built there, merged with the
    # mandatory allowedExternalPaths grant, rather than here.
    # kimi provider catalogs expose supported and default effort values, but a
    # launch flag and mapping have not been live-verified; the requested axis
    # stays in task metadata but never reaches the launch command. Cursor encodes
    # effort in model ids such as cursor-grok-4.5-high, so it also receives no
    # separate effort flag.
  esac
}

# fm_worker_effort_pin <config-dir>: print the pinned effort, empty when
# config/crew-effort is absent. Non-zero with the reason on stderr when the
# file is unreadable or does not hold exactly xhigh or max.
fm_worker_effort_pin() {
  local file=$1/crew-effort present value
  present=$(perl -MErrno=ENOENT -e '
    if (lstat $ARGV[0]) { print 1 }
    elsif ($! == ENOENT) { print 0 }
    else { die "error: cannot inspect config/crew-effort: $!\n" }
  ' -- "$file") || return 1
  [ "$present" = 1 ] || return 0
  if [ ! -f "$file" ] || [ ! -r "$file" ]; then
    echo "error: config/crew-effort must be a readable regular file" >&2
    return 1
  fi
  value=$(cat "$file") || {
    echo "error: cannot read config/crew-effort" >&2
    return 1
  }
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  case "$value" in
  xhigh | max) printf '%s' "$value" ;;
  *)
    echo "error: config/crew-effort must hold exactly xhigh or max (got '$value'); fix or remove the file" >&2
    return 1
    ;;
  esac
}

# fm_worker_effort_effective_pin <config-dir>: print the local pin, or the
# optional pin forwarded by a remote parent. A conflicting local/forwarded pin
# refuses instead of silently selecting one home's policy over the other.
fm_worker_effort_effective_pin() {
  local pin override=${FM_WORKER_EFFORT_PIN_OVERRIDE:-}
  pin=$(fm_worker_effort_pin "$1") || return 1
  if [ -n "$override" ]; then
    case "$override" in
    xhigh | max) ;;
    *)
      echo "error: invalid forwarded worker effort pin '$override'; expected xhigh or max" >&2
      return 1
      ;;
    esac
    if [ -n "$pin" ] && [ "$pin" != "$override" ]; then
      echo "error: forwarded worker effort pin '$override' conflicts with this home's config/crew-effort pin '$pin'" >&2
      return 1
    fi
    pin=$override
  fi
  printf '%s' "$pin"
}

# fm_worker_effort_apply <config-dir> <requested> <harness> <model> <raw 0|1>:
# print the effort this launch must use. Without a pin that is <requested>
# unchanged. With a pin, an omitted request ('', '-', default) resolves to the
# pin, and a different request, a raw launch, or a runtime that cannot carry the
# pinned level natively is refused.
fm_worker_effort_apply() {
  local config=$1 requested=$2 harness=$3 model=$4 raw=$5 pin native
  pin=$(fm_worker_effort_effective_pin "$config") || return 1
  if [ -z "$pin" ]; then
    printf '%s' "$requested"
    return 0
  fi
  case "$requested" in
  '' | - | default | "$pin") ;;
  *)
    echo "error: config/crew-effort pins worker effort to $pin, but this launch requests $requested; omit the effort or request $pin" >&2
    return 1
    ;;
  esac
  if [ "$raw" = 1 ]; then
    echo "error: config/crew-effort pins worker effort to $pin, but a raw launch command cannot be verified to carry it; launch a verified --harness instead" >&2
    return 1
  fi
  if [ "$harness" = dsh ]; then
    echo "error: config/crew-effort pins worker effort to $pin, but DSH reports selected-model effort support only after ACP session setup; refusing before launch rather than risk using the native default" >&2
    return 1
  fi
  case "$model" in - | default) model= ;; esac
  native=$(fm_effort_flag_for_harness "$harness" "$pin" "$model")
  if [ -z "$native" ]; then
    echo "error: config/crew-effort pins worker effort to $pin, but the $harness runtime${model:+ with model $model} has no verified native setting for it, so this launch is refused rather than running without it; choose a runtime that supports $pin or remove the pin" >&2
    return 1
  fi
  printf '%s' "$pin"
}

# fm_worker_effort_validate_pi_capability <config-dir> <harness> <executable>
#   <model|default> <cwd> <agent-dir|empty> <provider|empty> <session-ref|empty>
#   <approved-project 0|1>
# A configured/forwarded pin must exist in Pi's native supported-level list for
# the model Pi will actually select. The checker uses the selected account root,
# reads any resumed session without changing it, and runs offline with in-memory
# model/auth stores. Unpinned launches never invoke it.
fm_worker_effort_validate_pi_capability() {
  local config=$1 harness=$2 executable=$3 model=$4 cwd=$5 agent_dir=$6 provider=$7 session_ref=$8 approve=$9
  local pin fallback out rc
  pin=$(fm_worker_effort_effective_pin "$config") || return 1
  [ -n "$pin" ] || return 0
  case "$harness" in pi | pi-signed) ;; *) return 0 ;; esac
  [ -x "$executable" ] || {
    echo "error: cannot verify the pinned Pi effort because the selected $harness executable is unavailable" >&2
    return 1
  }
  [ -d "$cwd" ] || {
    echo "error: cannot verify the pinned Pi effort because the selected model's working directory is unavailable: $cwd" >&2
    return 1
  }
  case "$approve" in 0 | 1 | 2) ;; *) approve=0 ;; esac
  fallback=$(type -P -- pi 2>/dev/null || true)
  if out=$(fm_run_timed 20 node "$_FM_WORKER_EFFORT_LIB_DIR/fm-pi-effort-check.mjs" \
    "$executable" "$fallback" "$model" "$pin" "$cwd" "$agent_dir" "$provider" "$session_ref" "$approve" 2>&1); then
    return 0
  else
    rc=$?
  fi
  if [ -n "$out" ]; then
    printf '%s\n' "$out" >&2
  elif [ "$rc" -eq 124 ]; then
    echo "error: Pi's offline model-capability check timed out; refusing the pinned effort" >&2
  else
    echo "error: Pi's offline model-capability check failed (exit $rc); refusing the pinned effort" >&2
  fi
  return 1
}
