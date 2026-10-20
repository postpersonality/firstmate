#!/usr/bin/env bash
# Outgoing mail gate through the public CLI; transports are fixtures BEFORE RED.
set -euo pipefail
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ALERT_TMP=$(fm_test_tmproot fm-captain-alert)
mkdir -p "$ALERT_TMP/fakebin" "$ALERT_TMP/py" "$ALERT_TMP/critic" "$ALERT_TMP/home/data/demo" \
  "$ALERT_TMP/home/state/demo.inbox/handled" "$ALERT_TMP/home/data/escape" "$ALERT_TMP/home/data/nometa"
export FM_HOME="$ALERT_TMP/home" ALERT_TMP
unset FM_SMTP_PORT FM_IMAP_HOST
export FM_MAIL_USER=sender@example.invalid FM_MAIL_PASS=fixture-password FM_SMTP_HOST=smtp.invalid \
  FM_CAPTAIN_ALERT_TO=owner@example.invalid FM_CAPTAIN_ALERT_CLAUDE="$ALERT_TMP/critic/claude"
export PYTHONPATH="$ALERT_TMP/py" PATH="$ALERT_TMP/fakebin:$PATH"
# A forged critic on PATH must never be reached: the gate pins an absolute path.
cat > "$ALERT_TMP/fakebin/claude" <<'SH'
#!/usr/bin/env bash
: > "$ALERT_TMP/forged-critic"
exit 1
SH
# No live native call or SMTP can happen, including before the feature exists.
cat > "$ALERT_TMP/py/smtplib.py" <<'PY'
import json, os
class SMTP_SSL:
    def __init__(self, *a, **kw): pass
    def __enter__(self): return self
    def __exit__(self, *a): pass
    def login(self, *a):
        if os.environ.get('SMTP_LOGIN_FAIL'): raise RuntimeError('fixture-password')
    def send_message(self, message):
        if os.environ.get('SMTP_FAIL'): raise RuntimeError('fixture-password')
        with open(os.environ['ALERT_TMP'] + '/smtp', 'a') as f:
            f.write(message['Subject'] + '\n')
        with open(os.environ['ALERT_TMP'] + '/message.json', 'w') as f:
            json.dump({'body': message.get_content(), 'to': message['To']}, f)
PY
cat > "$ALERT_TMP/critic/claude" <<'PY'
#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ['ALERT_TMP'])
p = json.load(sys.stdin)
with (root / 'reviews').open('a') as f: f.write(p['request']['id'] + '\n')
assert 'fixture-password' not in json.dumps(p)
assert not any(k.startswith('FM_') for k in os.environ), 'critic inherited Firstmate configuration'
if os.environ.get('CRITIC_FAIL'): sys.exit(7)
if os.environ.get('CRITIC_INVALID'): print('{}'); sys.exit(0)
if os.environ.get('CRITIC_CHANGE'):
    (root / 'home/data/demo/brief.md').write_text('Changed accepted intent')
if os.environ.get('CRITIC_RESPAWN'):
    (root / 'home/state/demo.meta').write_text('kind=ship\nspawn_gen=s2.2.2\n')
verdict = 'SELF_RESOLVE' if p['request']['id'] in ('Q23', 'next-step') else 'NEEDS_CAPTAIN'
if os.environ.get('CRITIC_INSUFFICIENT'): verdict = 'INSUFFICIENT_EVIDENCE'
review = {'verdict': verdict, 'request_sha256': p['request_sha256'],
          'reason': 'Existing intent already authorizes correction' if verdict == 'SELF_RESOLVE' else 'Only the owner can grant publication permission',
          'action': 'Apply the already authorized correction' if verdict == 'SELF_RESOLVE' else 'Ask owner for explicit publication permission',
          'human_only': '' if verdict == 'SELF_RESOLVE' else 'Permission for public publication',
          'evidence': [{'source': s['role'], 'quote': s['text']} for s in p['sources']]}
if os.environ.get('CRITIC_BAD_HASH'): review['request_sha256'] = 'wrong'
print(json.dumps({'type':'result', 'subtype':'success', 'is_error':False,
                  'session_id':'fixture-session', 'modelUsage':{'fixture-model':{}},
                  'result':json.dumps(review)}))
PY
chmod +x "$ALERT_TMP/fakebin/claude" "$ALERT_TMP/critic/claude"
# Canonical records the gate reads itself; the request names only the task.
BRIEF='Correct Q23 authority wording; proceed with ordinary in-scope fixes.'
printf '%s' "$BRIEF" > "$FM_HOME/data/demo/brief.md"
printf '%s' 'No public publication without explicit owner permission.' > "$FM_HOME/state/demo.inbox/handled/000.msg"
printf '%s' 'Ordinary accepted work remains authorized; public publication still needs explicit permission.' > "$FM_HOME/state/demo.inbox/001.msg"
# One open decision per sending case: delivery is deduplicated per decision.
printf '%s\n' 'blocked: publication permission is absent' \
  'blocked [key=retry]: publication permission is absent; the first review failed' \
  'blocked [key=recipient]: publication permission is absent; the recipient moved' \
  'blocked [key=attempt]: publication permission is absent; SMTP may fail mid-send' \
  'blocked [key=login]: publication permission is absent; SMTP login may fail' > "$FM_HOME/state/demo.status"
printf '%s\n' kind=ship spawn_gen=s1.1.1 > "$FM_HOME/state/demo.meta"
printf '%s' 'Only the human owner may authorize public publication.' > "$FM_HOME/AGENTS.md"
printf '%s' 'Outside the home.' > "$ALERT_TMP/outside.md"
ln -s "$ALERT_TMP/outside.md" "$FM_HOME/data/escape/brief.md"
printf '%s' "$BRIEF" > "$FM_HOME/data/nometa/brief.md"
printf '%s\n' 'blocked: publication permission is absent' > "$FM_HOME/state/nometa.status"
python3 - <<'PY'
import json, os
from pathlib import Path
r = Path(os.environ['ALERT_TMP'])
for key in ['Q23','next-step','permission','failed','invalid','changed','bad-hash','smtp-fail','insufficient',
            'recipient-change','ghost','escape','with-sources','nopass','relative','shared-env',
            'reworked-a','reworked-b','respawn','unreadable','nometa','login-fail','permission-twin','smtp-fail-twin']:
    task = {'ghost':'ghost', 'escape':'escape', 'reworked-a':'reworked', 'nometa':'nometa'}.get(key, 'demo')
    decision = {'reworked-b':'stale', 'failed':'retry', 'recipient-change':'recipient', 'smtp-fail':'attempt',
                'smtp-fail-twin':'attempt', 'login-fail':'login'}.get(key, 'default')
    request = {'id':key, 'task':task, 'decision':decision,
        'subject':'Permission needed: ' + key,
        'body':'-' if key.startswith('permission') else 'Please grant publication permission.', 'analysis':{
          'why_blocked':'Publication needs human consent', 'attempts':['Verified consent is absent'],
          'alternatives':['Keep local work ready; publication cannot proceed'],
          'human_only':'Explicit public publication permission'}}
    if key == 'with-sources':
        request['sources'] = [{'role':'authority', 'path':str(r / 'outside.md')}]
    (r / (key + '.json')).write_text(json.dumps(request))
PY
: > "$ALERT_TMP/reviews"
mail_cli() { bash "$ROOT/bin/fm-mail.sh" "$@"; }
reviews() { wc -l < "$ALERT_TMP/reviews" | tr -d ' '; }
reject() {
  local rc=0
  mail_cli alert "$ALERT_TMP/$1.json" > "$ALERT_TMP/out" 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || fail "$1 must reject mail"
  [ ! -e "$ALERT_TMP/smtp" ] || fail "$1 reached SMTP"
}
# reject_unreviewed <id> <expected text>: refused before any critic call.
reject_unreviewed() {
  local before
  before=$(reviews)
  reject "$1"
  assert_contains "$(cat "$ALERT_TMP/out")" "$2" "$1 names its concrete gap"
  [ "$(reviews)" = "$before" ] || fail "$1 reached the critic"
}

reject Q23
assert_contains "$(cat "$ALERT_TMP/out")" SELF_RESOLVE 'Q23 gets concrete independent rejection'
grep -rlF 'Blocker email Q23: SELF_RESOLVE' "$FM_HOME/state/inbox" >/dev/null || fail 'rejection must reach durable inbox'
before=$(reviews)
reject Q23
[ "$(reviews)" = "$before" ] || fail 'unchanged self-resolvable event was reviewed again'
CRITIC_FAIL=1 reject next-step
reject next-step
grep -rqF 'Blocker email next-step: NO_MAIL' "$FM_HOME/state/inbox" || fail 'a failed review must reach the inbox'
grep -rqF 'Blocker email next-step: SELF_RESOLVE' "$FM_HOME/state/inbox" || fail 'the retried outcome must reach the inbox too'
pass 'authorized corrections return to Firstmate without mail; each new outcome is a new note'

FM_MAIL_PASS= reject_unreviewed nopass 'configure FM_MAIL_PASS'
before=$(reviews)
CRITIC_INSUFFICIENT=1 reject nopass
[ "$(reviews)" -gt "$before" ] || fail 'a repaired configuration gap was not reviewed fresh'
FM_CAPTAIN_ALERT_CLAUDE=claude reject_unreviewed relative 'PATH is never searched'
printf '# unrelated\n' > "$FM_HOME/.env"
chmod 640 "$FM_HOME/.env"
reject_unreviewed shared-env 'chmod 600'
rm "$FM_HOME/.env"
pass 'configuration gaps are named before any critic call and retry fresh once repaired'

reject_unreviewed ghost 'lacks its canonical brief record'
reject_unreviewed escape 'inside the Firstmate home'
reject_unreviewed with-sources 'the gate reads the evidence'
pass 'evidence comes only from canonical task records inside the home'

printf '%s' 'Later steering the gate cannot read.' > "$FM_HOME/state/demo.inbox/002.msg"
chmod 000 "$FM_HOME/state/demo.inbox/002.msg"
reject_unreviewed unreadable 'cannot read state/demo.inbox/002.msg'
rm -f "$FM_HOME/state/demo.inbox/002.msg"
chmod 000 "$FM_HOME/state/demo.inbox/handled"
reject_unreviewed unreadable 'cannot list state/demo.inbox/handled'
chmod 755 "$FM_HOME/state/demo.inbox/handled"
chmod 000 "$FM_HOME/state/demo.meta"
reject_unreviewed unreadable 'cannot read state/demo.meta'
chmod 644 "$FM_HOME/state/demo.meta"
reject_unreviewed nometa 'lacks its task record state/nometa.meta'
pass 'a missing or unreadable record is named with its path, never skipped'

cp "$ALERT_TMP/reworked-a.json" "$ALERT_TMP/reworked.json"
reject_unreviewed reworked 'task reworked lacks its canonical brief record'
cp "$ALERT_TMP/reworked-b.json" "$ALERT_TMP/reworked.json"
reject_unreviewed reworked 'decision stale is not an open blocked or needs-decision record'
grep -rqF 'decision stale is not an open' "$FM_HOME/state/inbox" || fail 'a new correction at the same request path must reach the inbox'
pass 'only a currently open decision is reviewed; a new correction at one path is a new note'

CRITIC_INVALID=1 reject invalid
CRITIC_BAD_HASH=1 reject bad-hash
CRITIC_INSUFFICIENT=1 reject insufficient
before=$(reviews)
CRITIC_FAIL=1 reject failed
assert_contains "$(cat "$ALERT_TMP/out")" 'NO_MAIL' 'a failed critic sends nothing'
mail_cli alert "$ALERT_TMP/failed.json" > "$ALERT_TMP/out" || fail "a failed review blocks a fresh one: $(cat "$ALERT_TMP/out")"
[ "$(reviews)" -eq $((before + 2)) ] || fail 'a critic failure was cached instead of reviewed again'
rm "$ALERT_TMP/smtp"
pass 'failed, missing receipt and unbound critic verdict fail closed; a failed review retries fresh'

CRITIC_CHANGE=1 reject changed
assert_contains "$(cat "$ALERT_TMP/out")" 'changed during review' 'changed records cannot consume an earlier approval'
printf '%s' "$BRIEF" > "$FM_HOME/data/demo/brief.md"
CRITIC_RESPAWN=1 reject respawn
assert_contains "$(cat "$ALERT_TMP/out")" 'changed during review' 'a new task generation cannot consume an earlier approval'
printf '%s\n' kind=ship spawn_gen=s1.1.1 > "$FM_HOME/state/demo.meta"
pass 'changed task records or generation cannot consume an earlier approval'

CRITIC_INSUFFICIENT=1 reject recipient-change
before=$(reviews)
FM_CAPTAIN_ALERT_TO=changed@example.invalid mail_cli alert "$ALERT_TMP/recipient-change.json" > "$ALERT_TMP/out" || fail "changed recipient was not sent: $(cat "$ALERT_TMP/out")"
[ "$(reviews)" -gt "$before" ] || fail 'recipient change needs fresh independent review'
python3 - <<'PY'
import json, os
from pathlib import Path
message = json.loads((Path(os.environ['ALERT_TMP']) / 'message.json').read_text())
assert message['to'] == 'changed@example.invalid', message
PY
rm "$ALERT_TMP/smtp"
pass 'changed recipient requires a new native review'

mail_cli alert "$ALERT_TMP/permission.json" > "$ALERT_TMP/out-a" &
alert_a=$!
mail_cli alert "$ALERT_TMP/permission-twin.json" > "$ALERT_TMP/out-b" &
alert_b=$!
wait "$alert_a"
wait "$alert_b"
[ "$(wc -l < "$ALERT_TMP/smtp" | tr -d ' ')" = 1 ] || fail 'two request ids for one open decision send exactly once'
python3 - <<'PY'
import json, os
from pathlib import Path
message=json.loads((Path(os.environ['ALERT_TMP'])/'message.json').read_text())
assert message['body'].strip() == '-', 'reviewed literal body changed in transport'
PY
before=$(reviews)
for id in permission permission-twin; do
  mail_cli alert "$ALERT_TMP/$id.json" > "$ALERT_TMP/out"
  assert_contains "$(cat "$ALERT_TMP/out")" 'already mailed' "$id replay names the deduplication"
done
[ "$(reviews)" = "$before" ] || fail 'replay invokes no critic'
[ "$(wc -l < "$ALERT_TMP/smtp" | tr -d ' ')" = 1 ] || fail 'replay sent again'
python3 - <<'PY'
import hashlib, json, os
from pathlib import Path
root = Path(os.environ['FM_HOME']) / 'state' / 'captain-alerts' / 'demo'
sent = [p for p in root.glob('*/sent.json') if json.loads(p.read_text())['id'].startswith('permission')]
assert len(sent) == 1, sent
marker = json.loads(sent[0].read_text())
transport = json.loads((sent[0].parent / marker['binding'] / 'transport.json').read_text())
critic = Path(os.environ['ALERT_TMP']) / 'critic' / 'claude'
assert transport['executable_sha256'] == hashlib.sha256(critic.read_bytes()).hexdigest(), transport
assert transport['session_id'] == 'fixture-session' and transport['modelUsage'], transport
assert transport['request_sha256'] == marker['binding'], (transport, marker)
PY
pass 'genuine human permission passes once per open decision, whatever the request id, with the exact critic and session recorded; repeat does not spam'

printf '%s\n' kind=ship spawn_gen=s2.2.2 > "$FM_HOME/state/demo.meta"
before=$(reviews)
mail_cli alert "$ALERT_TMP/permission.json" > "$ALERT_TMP/out" || fail "a new generation was not sent: $(cat "$ALERT_TMP/out")"
[ "$(reviews)" -gt "$before" ] || fail 'a new generation reused an earlier review'
[ "$(wc -l < "$ALERT_TMP/smtp" | tr -d ' ')" = 2 ] || fail 'a new generation under the same request id must send once'
printf '%s\n' kind=ship spawn_gen=s1.1.1 > "$FM_HOME/state/demo.meta"
printf '%s\n' 'blocked: publication permission is still absent after the first email' >> "$FM_HOME/state/demo.status"
before=$(reviews)
mail_cli alert "$ALERT_TMP/permission.json" > "$ALERT_TMP/out" || fail "a re-raised decision was not sent: $(cat "$ALERT_TMP/out")"
[ "$(reviews)" -gt "$before" ] || fail 'a re-raised decision reused an earlier review'
[ "$(wc -l < "$ALERT_TMP/smtp" | tr -d ' ')" = 3 ] || fail 'a re-raised decision under the same request id must send once'
pass 'a new generation or a re-raised decision is reviewed and sent afresh under the same request id'

rm "$ALERT_TMP/smtp"
rc=0
SMTP_FAIL=1 mail_cli alert "$ALERT_TMP/smtp-fail.json" > "$ALERT_TMP/out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail 'SMTP error must fail'
assert_not_contains "$(cat "$ALERT_TMP/out")" fixture-password 'SMTP error cannot leak credentials'
assert_not_contains "$(cat "$ALERT_TMP/out")" 'delivered' 'SMTP error cannot claim delivery'
before=$(reviews)
reject smtp-fail
assert_contains "$(cat "$ALERT_TMP/out")" 'already attempted' 'an attempted event is never sent twice'
reject smtp-fail-twin
assert_contains "$(cat "$ALERT_TMP/out")" 'already attempted' 'another request id for an attempted decision is never sent'
[ "$(reviews)" = "$before" ] || fail 'an attempted event was reviewed again'
pass 'SMTP failure is durable, never retried and never claims delivery'

rm -f "$ALERT_TMP/smtp"
before=$(reviews)
SMTP_LOGIN_FAIL=1 reject login-fail
assert_contains "$(cat "$ALERT_TMP/out")" 'before sending' 'a login failure is named as pre-send'
assert_not_contains "$(cat "$ALERT_TMP/out")" fixture-password 'a login error cannot leak credentials'
mail_cli alert "$ALERT_TMP/login-fail.json" > "$ALERT_TMP/out" || fail "a repaired login blocks a fresh review: $(cat "$ALERT_TMP/out")"
[ "$(reviews)" -eq $((before + 2)) ] || fail 'a repaired login reused the earlier review'
[ "$(wc -l < "$ALERT_TMP/smtp" | tr -d ' ')" = 1 ] || fail 'a repaired login must send exactly once'
pass 'a connection or login failure before sending permits a fresh review once repaired'

[ ! -e "$ALERT_TMP/forged-critic" ] || fail 'a critic found through PATH was executed'
pass 'a critic placed on PATH is never executed'

rc=0
mail_cli send arbitrary@example.invalid bypass body > "$ALERT_TMP/out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail 'legacy sender must not bypass critic'
pass 'ordinary legacy send entrypoint is closed'
rc=0
python3 "$ROOT/bin/fm-mail.py" send arbitrary@example.invalid bypass body > "$ALERT_TMP/out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail 'Python mail CLI must not bypass review'
pass 'Python mail CLI also closes unreviewed sending'
