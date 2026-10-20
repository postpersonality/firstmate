#!/usr/bin/env bash
# Opt-in native scope comparison: one call per fixed control, fixture SMTP only.
# FM_CAPTAIN_ALERT_LIVE_EVIDENCE optionally retains frozen proof after cleanup.
set -euo pipefail
# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
fm_live_gate opt-in FM_CAPTAIN_ALERT_LIVE claude python3
LIVE_ALERT_TMP=$(fm_test_tmproot fm-captain-alert-live)
LIVE_CLAUDE=$(command -v claude)
export LIVE_ALERT_TMP ROOT LIVE_CLAUDE
python3 - <<'PY'
from datetime import datetime, timezone
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess

root = Path(os.environ['LIVE_ALERT_TMP'])
# Install SMTP capture before any real critic call; no network is possible.
stub = root / 'py'; stub.mkdir()
(stub / 'smtplib.py').write_text('''import json, os
from pathlib import Path
class SMTP_SSL:
    def __init__(self, *a, **kw): pass
    def __enter__(self): return self
    def __exit__(self, *a): pass
    def login(self, *a): pass
    def send_message(self, message):
        with Path(os.environ['LIVE_ALERT_TMP'], 'smtp.jsonl').open('a') as out:
            out.write(json.dumps(dict(to=message['To'], body=message.get_content())) + '\\n')
''')
home = root / 'home'
home.mkdir()
shutil.copyfile(Path(os.environ['ROOT']) / 'AGENTS.md', home / 'AGENTS.md')
env = {k:v for k,v in os.environ.items() if not k.startswith(('FM_MAIL_', 'FM_IMAP_', 'FM_SMTP_', 'FM_CAPTAIN_ALERT_'))}
env.update(FM_HOME=str(home), FM_MAIL_USER='sender@example.invalid', FM_MAIL_PASS='synthetic-unused',
           FM_SMTP_HOST='smtp.invalid', FM_CAPTAIN_ALERT_TO='owner@example.invalid',
           FM_CAPTAIN_ALERT_CLAUDE=str(Path(os.environ['LIVE_CLAUDE']).resolve()), PYTHONPATH=str(stub))
fixture = Path(os.environ['ROOT']) / 'tests/fm-captain-alert-scope.json'
cases = json.loads(fixture.read_text())
critic = Path(env['FM_CAPTAIN_ALERT_CLAUDE'])
proof = dict(at=datetime.now(timezone.utc).isoformat(),
             native_version=subprocess.check_output([str(critic), '--version'], text=True, timeout=20).strip(),
             native_executable=str(critic), native_executable_sha256=hashlib.sha256(critic.read_bytes()).hexdigest(),
             fixture_sha256=hashlib.sha256(fixture.read_bytes()).hexdigest(),
             head=subprocess.check_output(['git', '-C', os.environ['ROOT'], 'rev-parse', 'HEAD'], text=True).strip(),
             cases=[], real_smtp=False, native_stdout='native.json is the parsed CLI envelope; transport.json hashes original stdout')
retained = os.environ.get('FM_CAPTAIN_ALERT_LIVE_EVIDENCE')
destination = Path(retained) if retained else root / 'proof'
destination.mkdir(mode=0o700, parents=True, exist_ok=False)
shutil.copyfile(fixture, destination / fixture.name)
failures = []
print(proof['native_version'], flush=True)
for case in cases:
    req = case['request']; key = req['id']; task = req['task']
    (home / 'data' / task).mkdir(parents=True)
    inbox = home / 'state' / (task + '.inbox') / 'handled'; inbox.mkdir(parents=True)
    (home / 'data' / task / 'brief.md').write_text(case['brief'])
    if 'steering' in case:
        (inbox / '000.msg').write_text(case['steering'])
    (home / 'state' / (task + '.status')).write_text(case['status'])
    (home / 'state' / (task + '.meta')).write_text('kind=ship\nspawn_gen=s1.1.1\n')
    request = root / (key + '.json'); request.write_text(json.dumps(req))
    proc = subprocess.run(['bash', os.environ['ROOT'] + '/bin/fm-mail.sh', 'alert', str(request)],
                          env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=240)
    receipts = home / 'state' / 'captain-alerts' / task
    saved = destination / key
    if receipts.exists():
        shutil.copytree(receipts, saved)
    else:
        saved.mkdir()
    (saved / 'stdout.txt').write_bytes(proc.stdout)
    (saved / 'stderr.txt').write_bytes(proc.stderr)
    # Each control keeps its own capture, so no later control inherits a message.
    capture = saved / 'smtp.jsonl'
    if (root / 'smtp.jsonl').exists():
        shutil.move(str(root / 'smtp.jsonl'), str(capture))
    review_paths = list(receipts.glob('*/*/review.json'))
    review = json.loads(review_paths[0].read_text()) if len(review_paths) == 1 else {}
    transport_paths = list(receipts.glob('*/*/transport.json'))
    transport = json.loads(transport_paths[0].read_text()) if len(transport_paths) == 1 else {}
    contexts = list(receipts.glob('*/*/context.json'))
    context = json.loads(contexts[0].read_text()) if len(contexts) == 1 else {}
    row = dict(id=key, expected=case['expected'], verdict=review.get('verdict'), exit_code=proc.returncode,
               session=transport.get('session_id'), models=transport.get('modelUsage'), binding=transport.get('request_sha256'))
    proof['cases'].append(row)
    (destination / 'manifest.json').write_text(json.dumps(proof, indent=2) + '\n')
    if (review.get('verdict') != case['expected'] or not row['session'] or not row['models'] or
            transport.get('exit_code') != 0 or context.get('request') != req or
            transport.get('executable_sha256') != proof['native_executable_sha256'] or
            not row['binding'] or row['binding'] != context.get('request_sha256') or
            row['binding'] != review.get('request_sha256')):
        failures.append(key + ': missing/failed/mismatched native evidence or classification')
    messages = [json.loads(line) for line in capture.read_text().splitlines()] if capture.exists() else []
    if case['expected'] == 'SELF_RESOLVE':
        if proc.returncode != 1 or messages or list(receipts.glob('*/sent.json')):
            failures.append(key + ': self-resolvable control was not rejected before SMTP')
    elif proc.returncode != 0 or messages != [{'to': 'owner@example.invalid', 'body': req['body'] + '\n'}]:
        failures.append(key + ': required human input did not reach fixture SMTP with the bound body/recipient')
    print('critic ' + key + ': ' + str(row['verdict']) + '; session=' + str(row['session']) + '; models=' + ','.join(row['models'] or {}), flush=True)
proof['failures'] = failures
(destination / 'manifest.json').write_text(json.dumps(proof, indent=2) + '\n')
assert not failures, failures
PY
