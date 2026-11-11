# shellcheck shell=bash
# Shared .env-style file accessor.
# Usage: . bin/fm-env-lib.sh
#
# This file is the single owner of the one-key .env read: the Relay pairing
# token (bin/fm-x-lib.sh and its callers), dispatch provider settings, and
# optional typesafe.ai, OpenRouter, System One-host, or OpenAI dispatch keys
# (bin/fm-dispatch-resolve.sh) resolve through fmx_env_get, so $FM_HOME/.env
# uses one parsing rule.
# (bin/fm-mail.sh loads its whole .env block itself under the same env-wins
# contract.) The value is printed to the caller's command substitution only;
# nothing is logged.

# fmx_env_get <key> <file>
# Read the value of KEY from a .env-style file: last assignment wins; tolerates a
# leading "export ", surrounding whitespace, and one layer of matching single or
# double quotes. Prints nothing (and succeeds) when the file or key is absent, so
# callers can treat empty output as "unset".
fmx_env_get() {
  local key=$1 file=$2 line
  [ -f "$file" ] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null | tail -n1) || return 0
  [ -n "$line" ] || return 0
  _fmx_env_value "$line"
}

# fmx_env_first <key> <file>
# fmx_env_get, except the first assignment with a nonempty value wins: the rule
# bin/fm-mail.sh's loader applies, for a caller that must agree with the mail
# plane's configuration (the drain's blocker-recipient presence check).
fmx_env_first() {
  local key=$1 file=$2 line val
  [ -f "$file" ] || return 0
  while IFS= read -r line; do
    val=$(_fmx_env_value "$line")
    [ -z "$val" ] || { printf '%s' "$val"; return 0; }
  done <<EOF
$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null)
EOF
}

# _fmx_env_value <line>: the value of one KEY=VALUE line, unwrapped as
# fmx_env_get describes.
_fmx_env_value() {
  local val=${1#*=}
  val=${val#"${val%%[![:space:]]*}"}   # strip leading whitespace
  val=${val%"${val##*[![:space:]]}"}   # strip trailing whitespace (incl. CR)
  case "$val" in
    \"*\") val=${val#\"}; val=${val%\"} ;;
    \'*\') val=${val#\'}; val=${val%\'} ;;
  esac
  printf '%s' "$val"
}
