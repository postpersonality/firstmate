<!-- Privacy-reviewed historical copy: paths and runtime identifiers are normalized; this is not a new test run. Recorded checksums refer to originals. See PRIVACY-NOTICE.md. -->

# Herdr lab provisioning in the gate's Bash sandbox (herdr herdr 0.8.2)

## 1. Guarded launcher e2e via HERDR_LAB_HELPER=<checkout>/bin/fm-herdr-lab.sh
fm-herdr-lab: lab session 'fm-lab-firstmate-herdr-69-13972' did not report running within 60 seconds
rc=1 elapsed=61s

## 2. Server stderr captured by a PATH logging shim under the same guarded 'provision' (no raw lifecycle call)
Error: Os { code: 30, kind: ReadOnlyFilesystem, message: "Read-only file system" }

## 3. strace -e trace=%file of that guarded provision
mkdir("<home>/.config/herdr/sessions/fm-lab-probe-65-25302", 0777) = -1 EROFS (Read-only file system)

## 4. Write probes from the sandboxed shell
read-only <home>/.config/herdr/sessions
read-only <home>/.config/herdr

## 5. Sandbox bwrap argument order (positions in the sandbox's own command line; credentials omitted)
209---bind  210:<home>/.config/herdr  211:<home>/.config/herdr
640---ro-bind  641:<home>/.config  642:<home>/.config
=> the later --ro-bind of ~/.config shadows the earlier writable --bind of ~/.config/herdr

## 6. Post-attempt cleanup / default tripwire state (read-only session list)
[{"privacy_note":"unrelated session inventory omitted"}]
lab state dir entries: 0
named session dirs: 0
