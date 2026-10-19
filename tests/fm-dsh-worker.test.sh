#!/usr/bin/env bash
# Portable behavior checks for the DSH ACP terminal worker; no model or backend.
set -eu
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
command -v node >/dev/null 2>&1 || { echo 'skip: node not found'; exit 0; }
LAB=$(fm_test_tmproot fm-dsh-worker)
trap 'fm_test_remove_tree "$LAB"' EXIT
node "$ROOT/tests/assets/fm-dsh-worker-regression.mjs" "$ROOT" "$LAB"
