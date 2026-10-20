import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run, runAsync } from './process.ts';
import { decode } from '@toon-format/toon';

export type FirstmateState = 'queued' | 'in_flight' | 'done';
export type FirstmateTask = {
  id: string; title: string; state: FirstmateState; body: string;
  kind?: string; repo?: string; created?: string; closed?: string;
  pr_url?: string; blocked_by?: string; blocked_by_ids?: string[]; unresolved_blocker_ids?: string[];
  held?: string | boolean; hold_reason?: string; hold_kind?: string; hold_until?: string; links?: unknown;
};

const inheritedNames = ['FM_HOME', 'FM_DATA_OVERRIDE', 'FM_ROOT_OVERRIDE', 'FM_STATE_OVERRIDE', 'FM_CONFIG_OVERRIDE', 'FM_PROJECTS_OVERRIDE', 'TASKS_AXI_FILE', 'TASKS_AXI_BACKEND'];

export class Firstmate {
  readonly home: string;
  private readonly command: string;
  constructor(home: string, command?: string) { this.home = resolve(home); this.command = command ?? join(this.home, 'bin', 'fm-tasks-axi.sh'); }

  private env() {
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('FM_') || inheritedNames.includes(name)) delete env[name];
    env.FM_HOME = this.home;
    return env;
  }

  private call(args: string[], command = this.command, input?: string) { return run(command, args, this.home, 45000, this.env(), input); }

  async snapshot(script: 'fm-bearings-snapshot.sh' | 'fm-fleet-snapshot.sh') { return JSON.parse(await runAsync(join(this.home, 'bin', script), ['--json'], this.home, 45000, this.env())); }

  private bodyArgs(body: string) {
    const folder = mkdtempSync(join(tmpdir(), 'delo-firstmate-body-'));
    const file = join(folder, 'body.md');
    writeFileSync(file, body, { mode: 0o600 });
    return { args: ['--body-file', file], cleanup: () => rmSync(folder, { recursive: true, force: true }) };
  }

  // Without an id tasks-axi mints one; an empty body is left out because tasks-axi refuses it.
  add(id: string | undefined, title: string, body = '', options: { kind?: string; repo?: string; blockedBy?: string } = {}) {
    const args = ['add', ...(id ? [id, title] : ['--mint', title]), ...(options.kind ? ['--kind', options.kind] : []), ...(options.repo ? ['--repo', options.repo] : []), ...(options.blockedBy ? ['--blocked-by', options.blockedBy] : [])];
    if (!body) return JSON.parse(this.call([...args, '--json'])).task as FirstmateTask;
    const file = this.bodyArgs(body);
    try { return JSON.parse(this.call([...args, ...file.args, '--json'])).task as FirstmateTask; }
    finally { file.cleanup(); }
  }

  // archive reads the done archive through the wrapper's read-only archive mode.
  show(id: string, archive = false) {
    return (decode(this.call([...(archive ? ['archive'] : []), 'show', id, '--full'])) as { task: FirstmateTask }).task;
  }

  private tasks(args: string[]) {
    // An empty backlog or archive reports tasks as a sentence, not a list.
    const tasks = (decode(this.call(args)) as { tasks?: unknown }).tasks;
    return (Array.isArray(tasks) ? tasks : []) as FirstmateTask[];
  }
  list(state?: FirstmateState) { return this.tasks(['list', ...(state ? ['--state', state] : []), '--fields', 'body,created,closed,held,hold_reason,hold_kind,hold_until,links']); }
  archive() { return this.tasks(['archive', 'list', '--fields', 'body,closed,links']); }

  update(id: string, patch: { title?: string; body?: string; kind?: string; repo?: string; archiveBody?: boolean }) {
    const args = ['update', id];
    if (patch.title !== undefined) args.push('--title', patch.title);
    if (patch.kind !== undefined) args.push('--kind', patch.kind);
    if (patch.repo !== undefined) args.push('--repo', patch.repo);
    if (patch.archiveBody) args.push('--archive-body');
    if (patch.body !== undefined) { const file = this.bodyArgs(patch.body); try { args.push(...file.args, '--json'); return JSON.parse(this.call(args)).task as FirstmateTask; } finally { file.cleanup(); } }
    args.push('--json');
    return JSON.parse(this.call(args)).task as FirstmateTask;
  }

  start(id: string) { return JSON.parse(this.call(['start', id, '--json'])).task as FirstmateTask; }
  done(id: string, note?: string) { return JSON.parse(this.call(['done', id, ...(note ? ['--note', note] : []), '--json'])).task as FirstmateTask; }
  reopen(id: string) { return JSON.parse(this.call(['reopen', id, '--json'])).task as FirstmateTask; }
  hold(id: string, reason: string, kind = 'parked', until?: string) { return JSON.parse(this.call(['hold', id, '--reason', reason, '--kind', kind, ...(until ? ['--until', until] : []), '--json'])).task as FirstmateTask; }
  priority(id: string, value: 0 | 2) { return JSON.parse(this.call(['update', id, '--priority', String(value), '--json'])).task as FirstmateTask; }
  unhold(id: string) { return JSON.parse(this.call(['unhold', id, '--json'])).task as FirstmateTask; }

  private script(name: string, args: string[], input?: string) { return this.call(args, join(this.home, 'bin', name), input); }
  // Exit 3 means the note is saved but the primary was not woken; the note still counts.
  // A start request also names its task, so firstmate reads it without parsing the text.
  note(text: string, requestId?: string, startTask?: string) {
    try { return JSON.parse(this.script('fm-inbox.sh', ['note', ...(requestId ? ['--request-id', requestId] : []), ...(startTask ? ['--kind', 'start', '--task', startTask] : []), '--json', '--', text])); }
    catch (error: any) { if (error.status === 3 && error.stdout) return JSON.parse(error.stdout); throw error; }
  }
  receipts() { return JSON.parse(this.script('fm-inbox.sh', ['receipts', '--all-pending', '--all-handled'])); }
  ready() { return JSON.parse(this.script('fm-inbox.sh', ['ready'])); }
  answer(id: string, answer: string, label: string, mode: 'done' | 'release') { return this.script('fm-captain-hold.sh', ['answers', '--source', 'delo', '--wake'], `${id}\t${answer}\t${label}\t${mode}\n`); }
  captainLater(id: string, reason: string, until: string) { return this.script('fm-captain-hold.sh', ['hold', id, '--reason', reason, '--until', until]); }
}
