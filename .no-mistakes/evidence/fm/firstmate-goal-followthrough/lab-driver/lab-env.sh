# Privacy-reviewed historical copy: paths and runtime identifiers are normalized; this is not a new test run. Recorded checksums refer to originals. See PRIVACY-NOTICE.md.
# Sourced by lab drivers: plain FM_HOME=<lab>, no overrides, private tmux socket.
ROOT=<validation-worktree>
LAB=$(cat "$TMPDIR/fm-lab-path"); W="$TMPDIR/fmtest"; P="$LAB/projects/sample"
export FM_HOME="$LAB" PATH="$W/tmuxshim:$W/stubs:$PATH" TMUX_TMPDIR="$LAB/tmux"
unset FM_ROOT_OVERRIDE FM_STATE_OVERRIDE FM_DATA_OVERRIDE FM_CONFIG_OVERRIDE FM_PROJECTS_OVERRIDE TMUX TMUX_PANE
labtmux() { tmux -L fm-lab "$@"; }
start_lab_tmux() {
  labtmux new-session -d -s firstmate -c "$ROOT" -e FM_HOME="$LAB" -e PATH="$PATH" bash --norc --noprofile -i
  labtmux set-option -g default-command "exec env PATH='$PATH' bash --norc --noprofile -i"
  export TMUX="$(labtmux display-message -p -t firstmate '#{socket_path},#{pid},0')" TMUX_PANE=%0
}
# run: print the command and its real output and exit code (transcript form)
run() { printf '\n$ %s\n' "$*"; "$@" 2>&1; printf '[exit %s]\n' "$?"; }
fmb() { local s=$1; shift; "$ROOT/bin/$s" "$@"; }
