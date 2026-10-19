#!/usr/bin/env node
// DSH ACP-to-terminal adapter. No daemon or alternate inbox/control plane.
// Usage: fm-dsh-worker.mjs --dsh-bin PATH --cwd DIR --state DIR --id ID
//          --gen TOKEN --brief FILE --runtime-home DIR [--config-home DIR]
//          [--model PROVIDER/MODEL] [--effort LEVEL]
// The runtime home is task-private; the native 0.1.5 settings/credential files
// are read by their own providers under a mutation-denying preload. No secret
// values are copied into the generated patch, command line, or diagnostics.
// Ctrl+C (and manual Escape) cancels the owned ACP prompt; /exit closes it.
// Herdr reporting requires --herdr-bin PATH --herdr-session NAME --herdr-pane ID.
// Canonical spawn supplies the exact recorded endpoint, never a default session.
// Outstanding prompts are busy; settlement/cancellation is unknown rather than
// a claim about later autonomous work. Native session completion is not task done.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as readline from 'node:readline';

const root = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: Object.fromEntries([
  'dsh-bin', 'cwd', 'state', 'id', 'gen', 'brief', 'runtime-home', 'config-home', 'model', 'effort',
  'herdr-bin', 'herdr-session', 'herdr-pane',
].map(name => [name, { type: 'string' }]).concat([['help', { type: 'boolean' }], ['check', { type: 'boolean' }]])) });
if (args.help) {
  console.log('Usage: fm-dsh-worker.mjs --dsh-bin PATH --cwd DIR --state DIR --id ID --gen TOKEN --brief FILE --runtime-home DIR [--config-home DIR] [--model PROVIDER/MODEL] [--effort LEVEL] [--herdr-bin PATH --herdr-session NAME --herdr-pane ID]\n       fm-dsh-worker.mjs --check --dsh-bin PATH (read-only version preflight)');
  process.exit(0);
}
let child, terminal, session, shuttingDown = false, childExited = false, childCode;
let started = false, active = false, draining = false, closedByUs = false;
let sequence = 0;
const pending = new Map(), queue = [];
let childClose, readinessTimer;
let reportSequence = 0;
const diagnostic = message => process.stderr.write(`DSH: ${message}\n`);
function atomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 });
  renameSync(tmp, path);
}
function event(state, name) {
  const result = spawnSync('bash', [join(root, 'fm-busy-event.sh'), 'apply', args.state, args.id, state,
    '--gen', args.gen, '--source', 'dsh-acp', '--event', name], { stdio: 'ignore', timeout: 5000 });
  if (result.status !== 0) throw new Error('busy generation is unavailable or retired');
  reportHerdr('report-agent', state === 'busy' ? 'working' : 'idle');
}
function reportHerdr(verb, state) {
  if (!args['herdr-bin']) return;
  const command = ['pane', verb, args['herdr-pane'], '--source', `firstmate:dsh:${args.gen}`, '--agent', 'dsh',
    '--seq', String(++reportSequence)];
  if (state) command.push('--state', state);
  command.push('--session', args['herdr-session']);
  const result = spawnSync(args['herdr-bin'], command, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  let error;
  try { error = result.stdout && JSON.parse(result.stdout).error; } catch { error = true; }
  if (result.status !== 0 || error) throw new Error('Herdr DSH lifecycle report was not accepted');
}
function ready() {
  if (started) return;
  event('busy', 'prompt-observed');
  atomic(join(args.state, `${args.id}.dsh-ready`), `${JSON.stringify({ gen: args.gen, pid: process.pid, sessionId: session.sessionId, cwd: args.cwd })}\n`);
  started = true;
  clearTimeout(readinessTimer);
}
function display(text) {
  if (terminal && process.stdout.isTTY) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
  process.stdout.write(`${text}\n`);
  terminal?.prompt(true);
}
function send(message) {
  if (!child || childExited || child.stdin.destroyed) throw new Error('ACP transport is closed');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}
function request(method, params, timeout = 45000) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = timeout ? setTimeout(() => {
      pending.delete(id);
      reject(new Error(`ACP timeout: ${method}`));
    }, timeout) : undefined;
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    try { send({ id, method, params }); } catch (error) { pending.get(id)?.reject(error); pending.delete(id); }
  });
}
function receive(line) {
  try { receiveMessage(line); }
  catch (error) { void fatal(error); }
}
function receiveMessage(line) {
  let message;
  try { message = JSON.parse(line); } catch { void fatal(new Error('DSH emitted non-protocol stdout')); return; }
  if (message.id !== undefined && !message.method) {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    // Vendor errors may contain HTTP headers or configuration. Never relay them.
    if (message.error) item.reject(new Error(`ACP request failed (code ${Number(message.error.code) || 'unknown'})`));
    else item.resolve(message.result);
  } else if (message.method === 'session/request_permission') {
    const option = message.params?.options?.find(item => item.kind === 'allow_once');
    send({ id: message.id, result: { outcome: option
      ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
  } else if (message.method === 'session/update' && message.params?.sessionId === session?.sessionId) {
    const update = message.params.update;
    if (active && ['tool_call', 'agent_message_chunk', 'agent_thought_chunk'].includes(update?.sessionUpdate)) ready();
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') display(update.content.text);
    else if (update?.sessionUpdate === 'tool_call') display(`[DSH tool ${String(update.title || 'started').replace(/[\r\n\x00-\x1f]/g, ' ')}]`);
  }
}
function cancel() {
  if (!session || shuttingDown || !active) return;
  send({ method: 'session/cancel', params: { sessionId: session.sessionId } });
}
async function close() {
  if (shuttingDown) return;
  shuttingDown = true;
  queue.length = 0;
  if (child && !childExited) {
    if (session) {
      try { await request('session/close', { sessionId: session.sessionId }, 8000); }
      catch { process.exitCode = 1; diagnostic('session close was not confirmed'); }
    }
    closedByUs = true;
    child.stdin.end();
    const terminate = signal => {
      if (childExited) return;
      process.exitCode = 1;
      // The pipe-only child owns this new process group, never the pane shell.
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    };
    const timer = setTimeout(() => terminate('SIGTERM'), 6000);
    const killTimer = setTimeout(() => terminate('SIGKILL'), 8000);
    await childClose;
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (childCode !== 0) process.exitCode = 1;
  }
  terminal?.close();
  clearTimeout(readinessTimer);
  process.stdin.pause();
  try { reportHerdr('release-agent'); }
  catch { process.exitCode = 1; diagnostic('Herdr DSH lifecycle release was not accepted'); }
}
async function fatal(error) {
  if (shuttingDown) return;
  process.exitCode = 1;
  diagnostic(error.message);
  try { event('unknown', 'transport-failed'); } catch {}
  await close();
}
async function drain() {
  if (draining || shuttingDown) return;
  draining = true;
  try {
    while (queue.length && !shuttingDown) {
      const text = queue.shift();
      event('busy', 'prompt-start');
      active = true;
      try {
        const outcome = await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] }, 0);
        if (typeof outcome?.stopReason !== 'string') throw new Error('invalid ACP prompt result');
        if (outcome.stopReason !== 'cancelled') ready();
        event('unknown', outcome?.stopReason === 'cancelled' ? 'cancelled' : 'prompt-ended');
        writeFileSync(join(args.state, `${args.id}.turn-ended`), '');
        if (outcome?.stopReason === 'cancelled') display('[DSH cancelled]');
      } finally { active = false; }
    }
  } catch (error) { await fatal(error); }
  finally { draining = false; }
}
function submit(line) {
  if (line.trim() === '/exit') { void close(); return; }
  if (!line.trim()) return;
  queue.push(line);
  void drain();
}

try {
  if (!args['dsh-bin']) throw new Error('--dsh-bin is required');
  const binary = realpathSync(args['dsh-bin']);
  const packageRoot = dirname(dirname(binary));
  const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (metadata.name !== '@deepseek-ai/dsh' || metadata.version !== '0.1.5-rc.1') {
    throw new Error('unsupported DSH runtime; verified native configuration requires @deepseek-ai/dsh 0.1.5-rc.1');
  }
  const probe = spawnSync(process.execPath, [binary, '--version'], { encoding: 'utf8', timeout: 10000 });
  if (probe.status !== 0 || probe.stdout.trim() !== metadata.version) throw new Error('DSH version probe failed');
  if (args.check) { console.log(`@deepseek-ai/dsh ${metadata.version}`); process.exit(0); }
  for (const key of ['dsh-bin', 'cwd', 'state', 'id', 'gen', 'brief', 'runtime-home']) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(args.id) || !/^[A-Za-z0-9._-]+$/.test(args.gen)) throw new Error('invalid task identity');
  const herdrFields = ['herdr-bin', 'herdr-session', 'herdr-pane'].filter(key => args[key]);
  if (herdrFields.length && herdrFields.length !== 3) throw new Error('Herdr reporting requires its executable, session and pane together');
  for (const key of ['cwd', 'state', 'brief', 'runtime-home']) args[key] = resolve(args[key]);
  args['config-home'] = resolve(args['config-home'] || process.env.DSH_HOME || join(homedir(), '.dsh'));
  if (args['config-home'] === args['runtime-home']) throw new Error('runtime home must be task-private');
  if (existsSync(args['runtime-home'])) {
    const st = lstatSync(args['runtime-home']);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) {
      throw new Error('runtime home must be a private user-owned directory');
    }
  }
  mkdirSync(args['runtime-home'], { recursive: true, mode: 0o700 });
  let selected;
  const settings = join(args['config-home'], 'settings.yaml');
  if (existsSync(settings)) {
    const require = createRequire(join(packageRoot, 'package.json'));
    let document;
    try { document = require('yaml').parse(readFileSync(settings, 'utf8'), { logLevel: 'silent' }); }
    catch { throw new Error('native DSH settings could not be parsed (details withheld)'); }
    const native = document?.['agent-default-model'];
    if (native?.provider && native?.model) selected = { provider: native.provider, model: native.model };
  }
  const initialSelection = selected;
  if (args.model) {
    const split = args.model.indexOf('/');
    if (split < 1 || split === args.model.length - 1) throw new Error('model must name PROVIDER/MODEL');
    selected = { provider: args.model.slice(0, split), model: args.model.slice(split + 1) };
  }
  const patch = [];
  // Do not seed ACP with a requested model: its native current-option fallback
  // would make an unavailable request look advertised. Discover first, then select.
  if (initialSelection) patch.push({ id: 'acp', config: initialSelection });
  const credential = join(args['config-home'], '.credentials.yaml');
  const nativeFiles = existsSync(settings) || existsSync(credential);
  if (existsSync(settings)) patch.push({ id: 'settings', config: { path: settings, watch: false } });
  if (existsSync(credential)) patch.push({ id: 'credentials', config: { path: credential, watch: false } });
  const patchPath = join(args['runtime-home'], 'firstmate.patch.yml');
  // JSON is YAML-compatible and contains paths/route ids only, never config values.
  atomic(patchPath, `${JSON.stringify(patch)}\n`);
  const launch = nativeFiles ? ['--import', join(root, 'fm-dsh-readonly.mjs'), binary] : [binary];
  const env = { ...process.env, DSH_HOME: args['runtime-home'], DSH_PERMISSION_MODE: 'danger-full-access', FM_DSH_PACKAGE_ROOT: packageRoot };
  for (const key of ['CLAUDECODE', 'PI_CODING_AGENT', 'FM_PI_HARNESS', 'FM_OMP_HARNESS', 'GROK_AGENT', 'GEMINI_CLI', 'CURSOR_AGENT', 'CURSOR_INVOKED_AS', 'FM_SUPERVISION_ACTOR', 'FM_SUPERVISION_PRIMARY_HARNESS']) delete env[key];
  readinessTimer = setTimeout(() => { if (!started && !shuttingDown) void fatal(new Error('initial prompt was not observed before the readiness deadline')); }, 90000);
  child = spawn(process.execPath, [...launch, '--profile', 'acp', '--patch', patchPath], { cwd: args.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  childClose = new Promise(resolve => child.once('close', code => {
    childExited = true; childCode = code;
    for (const item of pending.values()) item.reject(new Error('DSH child exited'));
    pending.clear(); resolve();
    if (!closedByUs && !shuttingDown) void fatal(new Error('DSH child exited unexpectedly'));
  }));
  child.on('error', () => { void fatal(new Error('DSH child could not start')); });
  child.stdin.on('error', () => { void fatal(new Error('ACP transport write failed')); });
  process.on('SIGINT', cancel);
  process.on('SIGTERM', () => { void close(); });
  process.on('SIGHUP', () => { void close(); });
  // Deliberately drain without forwarding: native plugin errors can include secrets.
  child.stderr.resume();
  readline.createInterface({ input: child.stdout }).on('line', receive);
  await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'firstmate', version: '1' } });
  session = await request('session/new', { cwd: args.cwd, mcpServers: [] });
  if (!session?.sessionId || !Array.isArray(session.configOptions)) throw new Error('invalid DSH session response');
  if (selected) {
    const choices = session.configOptions.find(option => option.id === 'model')?.options?.flatMap(group => group.options || [group]) || [];
    const choice = choices.find(option => option.value === JSON.stringify([selected.provider, selected.model]));
    if (!choice) throw new Error('model is not advertised by the native DSH catalog');
    const changed = await request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: choice.value });
    session.configOptions = changed?.configOptions || session.configOptions;
  }
  const effort = session.configOptions.find(option => option.id === 'reasoning_effort');
  if (args.effort && effort?.options?.some(option => option.value === args.effort)) {
    await request('session/set_config_option', { sessionId: session.sessionId, configId: 'reasoning_effort', value: args.effort });
  } else if (args.effort) diagnostic('requested effort is not advertised; preserving the native default');
  terminal = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY), prompt: '❯ ' });
  readline.emitKeypressEvents(process.stdin, terminal);
  terminal.on('line', submit);
  terminal.on('SIGINT', cancel);
  terminal.on('close', () => { if (!shuttingDown) void close(); });
  process.stdin.on('keypress', (_text, key) => { if (key?.name === 'escape') cancel(); });
  const encoded = spawnSync('bash', [join(root, 'fm-operational-input.sh'), 'encode', 'launch-brief'], { input: readFileSync(args.brief), encoding: 'utf8' });
  if (encoded.status !== 0) throw new Error('launch brief could not be encoded');
  terminal.prompt();
  submit(encoded.stdout);
} catch (error) { await fatal(error); }
