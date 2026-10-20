#!/usr/bin/env bash
# Outgoing mail gate through the public CLI; transports are fixtures BEFORE RED.
set -euo pipefail
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ALERT_TMP=$(fm_test_tmproot fm-captain-alert)
mkdir -p "$ALERT_TMP/fakebin" "$ALERT_TMP/py" "$ALERT_TMP/home/config"
export FM_HOME="$ALERT_TMP/home" ALERT_TMP
export FM_MAIL_USER=sender@example.invalid FM_MAIL_PASS=fixture-password
export FM_SMTP_HOST=smtp.invalid
unset FM_IMAP_HOST
export FM_CAPTAIN_ALERT_TO=owner@example.invalid
export PYTHONPATH="$ALERT_TMP/py" PATH="$ALERT_TMP/fakebin:$PATH"
# No live native call or SMTP can happen, including before the feature exists.
cat > "$ALERT_TMP/py/smtplib.py" <<'PY'
import json, os
class SMTP_SSL:
    def __init__(self, *a, **kw): pass
    def __enter__(self): return self
    def __exit__(self, *a): pass
    def login(self, *a): pass
    def send_message(self, message):
        if os.environ.get('SMTP_FAIL'): raise RuntimeError('fixture-password')
        with open(os.environ['ALERT_TMP'] + '/smtp', 'a') as f:
            f.write(message['Subject'] + '\n')
        with open(os.environ['ALERT_TMP'] + '/message.json', 'w') as f:
            json.dump({'body': message.get_content(), 'to': message['To']}, f)
PY
cat > "$ALERT_TMP/fakebin/claude" <<'PY'
#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ['ALERT_TMP'])
p = json.load(sys.stdin)
with (root / 'reviews').open('a') as f: f.write(p['request']['id'] + '\n')
assert 'fixture-password' not in json.dumps(p)
if os.environ.get('CRITIC_FAIL'): sys.exit(7)
if os.environ.get('CRITIC_INVALID'): print('{}'); sys.exit(0)
if os.environ.get('CRITIC_CHANGE'):
    Path(p['sources'][0]['path']).write_text('Changed accepted intent')
if os.environ.get('CRITIC_BODY_CHANGE'):
    target = root / (p['request']['id'] + '.json')
    request = json.loads(target.read_text()); request['body'] = 'Changed body'
    target.write_text(json.dumps(request))
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
chmod +x "$ALERT_TMP/fakebin/claude"
python3 - <<'PY'
import json, os
from pathlib import Path
r = Path(os.environ['ALERT_TMP'])
sources = []
for role, text in [('intent','Correct Q23 authority wording; proceed with ordinary in-scope fixes.'),
                   ('instructions','No public publication without explicit owner permission.'),
                   ('state','Publication permission is absent; local correction remains authorized.'),
                   ('authority','Only the human owner may authorize public publication.')]:
    p = r / (role + '.txt'); p.write_text(text)
    sources.append({'role':role, 'path':str(p)})
later = r / 'later-instructions.msg'
later.write_text('Subsequent instruction: ordinary accepted work remains authorized; public publication still needs explicit permission.')
sources.append({'role':'instructions', 'path':str(later)})
for key in ['Q23','next-step','permission','failed','invalid','changed','body-change','bad-hash','smtp-fail','missing','insufficient','recipient-change']:
    (r / (key + '.json')).write_text(json.dumps({'id':key, 'subject':'Permission needed: ' + key,
        'body':'-' if key == 'permission' else 'Please grant publication permission.', 'analysis':{
          'why_blocked':'Publication needs human consent', 'attempts':['Verified consent is absent'],
          'alternatives':['Keep local work ready; publication cannot proceed'],
          'human_only':'Explicit public publication permission'}, 'sources':sources}))
PY
mail_cli() { bash "$ROOT/bin/fm-mail.sh" "$@"; }
reject() {
  local rc=0
  mail_cli alert "$ALERT_TMP/$1.json" > "$ALERT_TMP/out" 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || fail "$1 must reject mail"
  [ ! -e "$ALERT_TMP/smtp" ] || fail "$1 reached SMTP"
}
reject Q23
assert_contains "$(cat "$ALERT_TMP/out")" SELF_RESOLVE 'Q23 gets concrete independent rejection'
reject next-step
[ -n "$(find "$FM_HOME/state/inbox" -name '*.note' -o -name '*.md' -o -name '*.txt' 2>/dev/null)" ] \
  || [ -n "$(ls "$FM_HOME/state/inbox" 2>/dev/null)" ] || fail 'rejection must reach durable inbox'
pass 'authorized corrections return to Firstmate without mail'
before=$(wc -l < "$ALERT_TMP/reviews")
rc=0
FM_MAIL_PASS='' mail_cli alert-preflight > "$ALERT_TMP/out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail 'preflight must report missing secret'
assert_contains "$(cat "$ALERT_TMP/out")" FM_MAIL_PASS 'preflight names the missing parameter'
[ "$(wc -l < "$ALERT_TMP/reviews")" = "$before" ] || fail 'preflight invoked native critic'
pass 'non-sending preflight names gaps without contacting critic or SMTP'
python3 - <<'PY'
import json, os
from pathlib import Path
r=Path(os.environ['ALERT_TMP'])
request=json.loads((r/'permission.json').read_text())
request['id']='missing-source'; request['sources']=[]
(r/'missing-source.json').write_text(json.dumps(request))
PY
reject missing-source
assert_contains "$(cat "$ALERT_TMP/out")" 'raw source' 'invalid evidence returns the concrete gap'
[ "$(wc -l < "$ALERT_TMP/reviews")" = "$before" ] || fail 'missing evidence reached critic'
pass 'missing source evidence is rejected durably before review'
CRITIC_FAIL=1 reject failed
CRITIC_INVALID=1 reject invalid
CRITIC_BAD_HASH=1 reject bad-hash
CRITIC_INSUFFICIENT=1 reject insufficient
pass 'failed, missing receipt and unbound critic verdict fail closed'
mkdir -p "$ALERT_TMP/no-critic-bin"
for tool in bash python3 dirname mktemp cat rm timeout perl; do
  tool_path=$(command -v "$tool") || continue
  ln -s "$tool_path" "$ALERT_TMP/no-critic-bin/$tool"
done
PATH="$ALERT_TMP/no-critic-bin" reject missing
pass 'absent native executable cannot send'
CRITIC_CHANGE=1 reject changed
printf '%s' 'Correct Q23 authority wording; proceed with ordinary in-scope fixes.' > "$ALERT_TMP/intent.txt"
CRITIC_BODY_CHANGE=1 reject body-change
pass 'changed source cannot consume an earlier approval'
FM_SMTP_HOST='' reject recipient-change
before=$(wc -l < "$ALERT_TMP/reviews")
FM_CAPTAIN_ALERT_TO=changed@example.invalid mail_cli alert "$ALERT_TMP/recipient-change.json" > "$ALERT_TMP/out"
[ "$(wc -l < "$ALERT_TMP/reviews")" -gt "$before" ] || fail 'recipient change needs fresh independent review'
rm "$ALERT_TMP/smtp"
pass 'changed recipient requires a new native review'
mail_cli alert "$ALERT_TMP/permission.json" > "$ALERT_TMP/out-a" &
alert_a=$!
mail_cli alert "$ALERT_TMP/permission.json" > "$ALERT_TMP/out-b" &
alert_b=$!
wait "$alert_a"
wait "$alert_b"
[ "$(wc -l < "$ALERT_TMP/smtp" | tr -d ' ')" = 1 ] || fail 'permission sends exactly once'
python3 - <<'PY'
import json, os
from pathlib import Path
message=json.loads((Path(os.environ['ALERT_TMP'])/'message.json').read_text())
assert message['body'].strip() == '-', 'reviewed literal body changed in transport'
PY
before=$(wc -l < "$ALERT_TMP/reviews")
mail_cli alert "$ALERT_TMP/permission.json" > "$ALERT_TMP/out"
[ "$(wc -l < "$ALERT_TMP/reviews")" = "$before" ] || fail 'replay invokes no critic'
[ "$(wc -l < "$ALERT_TMP/smtp" | tr -d ' ')" = 1 ] || fail 'replay sent again'
pass 'genuine human permission passes; repeat does not spam'
rc=0
SMTP_FAIL=1 mail_cli alert "$ALERT_TMP/smtp-fail.json" > "$ALERT_TMP/out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail 'SMTP error must fail'
assert_not_contains "$(cat "$ALERT_TMP/out")" fixture-password 'SMTP error cannot leak credentials'
assert_not_contains "$(cat "$ALERT_TMP/out")" 'delivered' 'SMTP error cannot claim delivery'
pass 'SMTP failure is durable and never claims delivery'
rc=0
mail_cli send arbitrary@example.invalid bypass body > "$ALERT_TMP/out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail 'legacy sender must not bypass critic'
pass 'ordinary legacy send entrypoint is closed'
rc=0
python3 "$ROOT/bin/fm-mail.py" send arbitrary@example.invalid bypass body > "$ALERT_TMP/out" 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail 'Python mail CLI must not bypass review'
pass 'Python mail CLI also closes unreviewed sending'
