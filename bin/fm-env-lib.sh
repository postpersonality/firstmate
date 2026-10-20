# shellcheck shell=bash
# Shared .env-style file accessor.
# Usage: . bin/fm-env-lib.sh
#
# This file is the single owner of the one-key .env read: the Relay pairing
# token (bin/fm-x-lib.sh and its callers) and the optional typesafe.ai dispatch
# key (bin/fm-dispatch-resolve.sh) resolve their value through fmx_env_get, and
# the drain's blocker-email recipient presence check (bin/fm-wake-drain.sh)
# through fmx_env_first, so those opt-in settings in $FM_HOME/.env are parsed by
# one rule. (bin/fm-mail.sh loads its whole .env block itself under the same
# env-wins contract, keeping the first nonempty assignment.) The value is
# printed to the caller's command substitution only; nothing is logged.

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
# plane's configuration.
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
