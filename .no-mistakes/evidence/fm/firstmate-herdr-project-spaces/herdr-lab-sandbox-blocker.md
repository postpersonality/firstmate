# Herdr lab provisioning in the gate's Bash sandbox (herdr herdr 0.8.2)

## 1. Guarded launcher e2e via HERDR_LAB_HELPER=/home/nikolayseliverstov/Projects/firstmate/bin/fm-herdr-lab.sh
fm-herdr-lab: lab session 'fm-lab-firstmate-herdr-69-13972' did not report running within 60 seconds
rc=1 elapsed=61s

## 2. Server stderr captured by a PATH logging shim under the same guarded 'provision' (no raw lifecycle call)
Error: Os { code: 30, kind: ReadOnlyFilesystem, message: "Read-only file system" }

## 3. strace -e trace=%file of that guarded provision
mkdir("/home/nikolayseliverstov/.config/herdr/sessions/fm-lab-probe-65-25302", 0777) = -1 EROFS (Read-only file system)

## 4. Write probes from the sandboxed shell
read-only /home/nikolayseliverstov/.config/herdr/sessions
read-only /home/nikolayseliverstov/.config/herdr

## 5. Sandbox bwrap argument order (positions in the sandbox's own command line; credentials omitted)
209---bind  210:/home/nikolayseliverstov/.config/herdr  211:/home/nikolayseliverstov/.config/herdr
640---ro-bind  641:/home/nikolayseliverstov/.config  642:/home/nikolayseliverstov/.config
=> the later --ro-bind of ~/.config shadows the earlier writable --bind of ~/.config/herdr

## 6. Post-attempt cleanup / default tripwire state (read-only session list)
[{"name":"default","default":true,"running":true,"socket_path":"/home/nikolayseliverstov/.config/herdr/herdr.sock"}]
lab state dir entries: 0
named session dirs: 0
