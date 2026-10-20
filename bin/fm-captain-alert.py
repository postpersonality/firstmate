#!/usr/bin/env python3
"""Outgoing blocker gate behind fm-mail.sh; no ungated send CLI.

alert <request.json>: freeze request + explicit source files, invoke a fresh native
critic, validate its transport/binding/citations, recheck sources, then SMTP.
Required request keys: id (stable event slug), subject, body, analysis containing
why_blocked, attempts[], alternatives[], human_only; sources[] with role and path.
At least one source each: intent, instructions (including every later instruction),
state, authority; up to 16 explicit credential-free UTF-8 files, <= 48 KiB total.
Source extensions: .md, .txt, .json, .msg (raw steering messages are supported).
Only nonsecret sender/recipient and a configuration-readiness digest enter prompts.
The request is evidence, not authority; its file must remain unchanged until send.
Receipts/snapshots: $FM_HOME/state/captain-alerts/<id>/<binding>/, mode 0700/0600.
Replays never resend. A sending/failed attempt is uncertain and never auto-retried.
A revised unsent proposal requires a fresh review. A delivered event stays deduped.
Denials/errors become idempotent fm-inbox notes, with concrete corrective action.
alert-preflight: local-only config checks; no native call, authentication or SMTP.
The native bound is 180s. No skip/configurable-off path exists.
"""
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

BIN = Path(__file__).resolve().parent
ROLES = {'intent', 'instructions', 'state', 'authority'}
MAX_BYTES = 49152


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()


def save(path, obj):
    tmp = path.with_suffix('.tmp')
    with tmp.open('w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)


def text_file(path):
    if (path.name.startswith('.') or any(part in {'.ssh', '.aws', '.claude', '.codex'} for part in path.parts)
            or path.suffix not in {'.md', '.txt', '.json', '.msg'}):
        raise ValueError('sources must be explicit credential-free .md/.txt/.json/.msg files')
    with path.open('rb') as stream:
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('source exceeds 48 KiB; provide the relevant evidence only')
    text = raw.decode('utf-8')
    secret = os.environ.get('FM_MAIL_PASS', '')
    if (secret and secret in text) or re.search(
            r'''(?im)["']?(?:password|api[_-]?key|access[_-]?token|secret)["']?\s*[=:]\s*["']?\S+''', text):
        raise ValueError('source may contain secrets; provide credential-free evidence')
    return text


def preflight(home):
    gaps = []
    for key in ('FM_MAIL_USER', 'FM_MAIL_PASS', 'FM_SMTP_HOST', 'FM_CAPTAIN_ALERT_TO'):
        if not os.environ.get(key):
            gaps.append('configure ' + key + ' in protected $FM_HOME/.env (never in chat/argv)')
    for key in ('FM_MAIL_USER', 'FM_CAPTAIN_ALERT_TO'):
        value = os.environ.get(key, '')
        if value and not re.fullmatch(r'[^\s<>@,;]+@[^\s<>@,;]+', value):
            gaps.append(key + ' must be one plain email address')
    port = os.environ.get('FM_SMTP_PORT', '465')
    if not port.isdecimal() or not 1 <= int(port) <= 65535 or port == '587':
        gaps.append('configure an implicit-TLS FM_SMTP_PORT (default 465; no STARTTLS)')
    env_file = home / '.env'
    if env_file.exists() and stat.S_IMODE(env_file.stat().st_mode) & 0o077:
        gaps.append('chmod 600 $FM_HOME/.env before activating SMTP')
    if not shutil.which('claude'):
        gaps.append('install/authenticate native claude using the intended existing identity')
    return gaps


def note(home, binding, message):
    # Existing inbox owns publication, wake durability and idempotent replay.
    env = dict(os.environ, FM_HOME=str(home))
    for key in ('FM_ROOT_OVERRIDE', 'FM_STATE_OVERRIDE', 'FM_DATA_OVERRIDE', 'FM_CONFIG_OVERRIDE', 'FM_PROJECTS_OVERRIDE'):
        env.pop(key, None)
    result = subprocess.run(['bash', str(BIN / 'fm-inbox.sh'), 'note',
                             '--request-id', 'captain-alert-' + binding, '-'],
                            input=message.encode(), stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, env=env, timeout=30)
    if result.returncode:
        raise ValueError('receipt saved; inbox publication failed; replay this exact request to repair')


def freeze(path, recipient):
    with path.open('rb') as stream:
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('request exceeds 48 KiB')
    req = json.loads(raw)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', req.get('id', '')):
        raise ValueError('request id must be a stable event slug')
    for key in ('subject', 'body'):
        if not isinstance(req.get(key), str) or not req[key].strip():
            raise ValueError('request requires nonempty ' + key)
    if '\n' in req['subject'] or '\r' in req['subject']:
        raise ValueError('subject must be a single line')
    analysis = req.get('analysis', {})
    for key in ('why_blocked', 'human_only'):
        if not isinstance(analysis.get(key), str) or not analysis[key].strip():
            raise ValueError('supply Firstmate analysis.' + key)
    for key in ('attempts', 'alternatives'):
        values = analysis.get(key)
        if not isinstance(values, list) or not values or not all(isinstance(v, str) and v.strip() for v in values):
            raise ValueError('supply concrete analysis.' + key)
    source_refs = req.get('sources', [])
    if not isinstance(source_refs, list) or not 4 <= len(source_refs) <= 16:
        raise ValueError('supply raw sources for intent, all instructions, state, authority (4..16 files)')
    sources = []
    for source in source_refs:
        if source.get('role') not in ROLES:
            raise ValueError('source role must be intent, instructions, state or authority')
        p = Path(source['path']).resolve(strict=True)
        content = text_file(p)
        sources.append(dict(role=source['role'], path=str(p), text=content,
                            sha256=digest(content.encode())))
    if not 4 <= len(sources) <= 16 or {s['role'] for s in sources} != ROLES:
        raise ValueError('supply raw sources for intent, all instructions, state, authority (4..16 files)')
    if sum(len(s['text'].encode()) for s in sources) > MAX_BYTES:
        raise ValueError('source context exceeds 48 KiB')
    readiness = {k: os.environ.get(k, '') for k in ('FM_MAIL_USER', 'FM_SMTP_HOST', 'FM_SMTP_PORT')}
    readiness['credential_present'] = bool(os.environ.get('FM_MAIL_PASS'))
    payload = dict(request=req, recipient=recipient, sender=os.environ.get('FM_MAIL_USER', ''),
                   delivery_configuration_sha256=digest(encoded(readiness)), sources=sources)
    secret = os.environ.get('FM_MAIL_PASS', '')
    if secret and secret in encoded(payload).decode():
        raise ValueError('request contains SMTP secret; remove it before review')
    if re.search(r'''(?im)["']?(?:password|api[_-]?key|access[_-]?token|secret)["']?\s*[=:]\s*["']?\S+''', encoded(req).decode()):
        raise ValueError('request may contain secrets; remove them before review')
    payload['request_sha256'] = digest(encoded(payload))
    return payload, digest(raw)


def critique(payload, directory):
    # Safe mode keeps the installed account/model while excluding custom prompts,
    # hooks and tools; a separate cwd prevents project role contamination too.
    with tempfile.TemporaryDirectory(prefix='critic-', dir=directory) as cwd:
        env = {k: v for k, v in os.environ.items() if not k.startswith(('FM_MAIL_', 'FM_SMTP_', 'FM_IMAP_'))}
        proc = subprocess.run(['bash', str(BIN / 'fm-captain-alert-review.sh')],
                              input=encoded(payload), stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, cwd=cwd, env=env, timeout=190)
    save(directory / 'transport.json', dict(command='fm-captain-alert-review.sh',
         executable=shutil.which('claude'), exit_code=proc.returncode,
         stdout_sha256=digest(proc.stdout), request_sha256=payload['request_sha256']))
    if proc.returncode or len(proc.stdout) > 131072:
        raise ValueError('native critic failed or exceeded bound; repair native transport and resubmit evidence')
    native = json.loads(proc.stdout)
    if (native.get('type') != 'result' or native.get('subtype') != 'success'
            or native.get('is_error') is not False or not native.get('session_id')
            or not native.get('modelUsage')):
        raise ValueError('missing successful native session/model evidence; repair critic transport')
    save(directory / 'native.json', native)
    review = native.get('structured_output')
    if review is None:
        review = json.loads(native['result'])
    save(directory / 'transport.json', dict(command='fm-captain-alert-review.sh',
         executable=shutil.which('claude'), exit_code=proc.returncode,
         stdout_sha256=digest(proc.stdout), request_sha256=payload['request_sha256'],
         session_id=native['session_id'], modelUsage=native['modelUsage']))
    if review.get('request_sha256') != payload['request_sha256']:
        raise ValueError('critic binding mismatch; review the exact current request')
    if review.get('verdict') not in ('NEEDS_CAPTAIN', 'SELF_RESOLVE', 'INSUFFICIENT_EVIDENCE'):
        raise ValueError('invalid critic verdict; require a concrete action and source-backed decision')
    if not all(isinstance(review.get(k), str) and review[k].strip() for k in ('reason', 'action')):
        raise ValueError('critic must provide reason and concrete corrective action')
    cited = set()
    for item in review.get('evidence', []):
        if any(s['role'] == item.get('source') and isinstance(item.get('quote'), str)
               and item['quote'].strip() and item['quote'] in s['text'] for s in payload['sources']):
            cited.add(item['source'])
        else:
            raise ValueError('critic citation is absent from frozen sources; supply exact evidence')
    if review['verdict'] == 'NEEDS_CAPTAIN' and (cited != ROLES or not review.get('human_only', '').strip()):
        raise ValueError('critic must cite every source and name the exact human-only input')
    save(directory / 'review.json', review)
    return review


def alert(home, request_path):
    recipient = os.environ.get('FM_CAPTAIN_ALERT_TO', '')
    payload, request_hash = freeze(request_path, recipient)
    binding = payload['request_sha256']
    root = home / 'state' / 'captain-alerts' / payload['request']['id']
    root.mkdir(parents=True, exist_ok=True)
    with (root / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        directory = root / binding
        directory.mkdir(exist_ok=True)
        receipt = directory / 'outcome.json'
        if (root / 'sent.json').exists():
            print('already-sent: this event is deduplicated')
            return 0
        if (root / 'attempted.json').exists() and not receipt.exists():
            message = 'SMTP was already attempted for this event; delivery may be uncertain. Inspect its receipt before a new event.'
            note(home, binding, message)
            print('NO_MAIL: ' + message)
            return 1
        if receipt.exists():
            outcome = json.loads(receipt.read_text())
            if outcome['status'] != 'SENT':
                note(home, binding, outcome['action'])
            print(outcome['status'] + ': ' + outcome['action'])
            return 0 if outcome['status'] == 'SENT' else 1
        save(directory / 'context.json', payload)
        # Reserve before invoking either external process. A crash is uncertain,
        # never an excuse to retry SMTP automatically or reuse a prior review.
        outcome = dict(status='REVIEWING', action='Interrupted review; inspect receipt and submit fresh current evidence', at=int(time.time()))
        save(receipt, outcome)
        try:
            review = critique(payload, directory)
            if review['verdict'] != 'NEEDS_CAPTAIN':
                outcome.update(status=review['verdict'], action=review['action'])
            else:
                current, current_hash = freeze(request_path, os.environ.get('FM_CAPTAIN_ALERT_TO', ''))
                if current != payload or current_hash != request_hash:
                    raise ValueError('request, recipient or source context changed; submit a fresh review')
                gaps = preflight(home)
                if gaps:
                    raise ValueError('; '.join(gaps))
                outcome.update(status='SENDING', action='SMTP outcome uncertain; inspect before any new notification')
                save(receipt, outcome)
                save(root / 'attempted.json', dict(binding=binding, at=int(time.time())))
                spec = importlib.util.spec_from_file_location('fm_mail', BIN / 'fm-mail.py')
                engine = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(engine)
                req = payload['request']
                with contextlib.redirect_stdout(io.StringIO()):
                    rc = engine._send_reviewed(recipient, req['subject'], req['body'])
                if rc:
                    raise ValueError('SMTP failed; delivery unconfirmed, no automatic retry; verify service before a new event')
                outcome.update(status='SENT', action='SMTP accepted the notification (inbox arrival unverified)')
                save(root / 'sent.json', dict(binding=binding, at=int(time.time())))
        except (ValueError, OSError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired):
            # Exceptions may contain provider/credential bytes. Only our controlled
            # ValueError messages are exposed, never raw SMTP/native stderr.
            error = sys.exc_info()[1]
            action = str(error) if type(error) is ValueError else 'Invalid evidence or critic failure; inspect scoped inputs and native transport'
            outcome.update(status='NO_MAIL', action=action)
        save(receipt, outcome)
        if outcome['status'] != 'SENT':
            note(home, binding, 'Blocker email ' + payload['request']['id'] + ': ' + outcome['status'] + '\n' + outcome['action'] + '\nReceipt: ' + str(receipt))
        print(outcome['status'] + ': ' + outcome['action'])
        return 0 if outcome['status'] == 'SENT' else 1


def main():
    os.umask(0o077)
    home = Path(os.environ['FM_HOME']).resolve()
    if sys.argv[1:] == ['alert-preflight']:
        gaps = preflight(home)
        print('\n'.join(gaps) if gaps else 'ready: local configuration present; native authentication and SMTP not contacted')
        return int(bool(gaps))
    if len(sys.argv) != 3 or sys.argv[1] != 'alert':
        print('usage: fm-mail.sh alert <request.json> | alert-preflight', file=sys.stderr)
        return 2
    try:
        return alert(home, Path(sys.argv[2]).resolve(strict=True))
    except (ValueError, OSError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired) as error:
        # Invalid submissions still reach the existing durable inbox, without
        # copying unvalidated context or exception messages into logs.
        gap = str(error) if type(error) is ValueError else 'invalid request or unavailable evidence; supply readable raw intent, instructions, state, authority and concrete attempts/alternatives'
        message = 'Blocker email rejected: ' + gap
        binding = digest(os.fsencode(sys.argv[2]))
        note(home, binding, message)
        print(message, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
