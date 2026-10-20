import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { id } from './model.ts';
import { runAsync } from './process.ts';

export type TerminalNavigation = { available: boolean; binding?: string; reason?: string };
const changed = 'Терминал изменился. Обновите страницу и повторите переход.';
const atom = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);

// Only the selected home's exact task metadata can authorize a terminal; labels and ambient panes cannot.
export async function workerTerminal(home: string, taskId: string, binding: string | undefined, runner: typeof runAsync, environment: NodeJS.ProcessEnv): Promise<TerminalNavigation> {
  try {
    if (!id.safeParse(taskId).success) throw new Error('Терминал недоступен: неверная задача.');
    const state = join(home, 'state'), path = join(state, `${taskId}.meta`);
    const read = () => {
      try {
        if (!lstatSync(state).isDirectory() || !lstatSync(path).isFile() || lstatSync(path).size > 131072) throw new Error(changed);
        return readFileSync(path, 'utf8');
      } catch { throw new Error(changed); }
    };
    let source: string;
    try { source = read(); } catch { throw new Error('Терминал недоступен: у этой задачи нет сохранённого окна.'); }
    const meta = new Map<string, string>();
    for (const line of source.split('\n').filter(Boolean)) {
      const entry = /^([a-z_]+)=(.*)$/.exec(line);
      if (!entry || meta.has(entry[1])) throw new Error('Терминал недоступен: не удалось подтвердить окно задачи.');
      meta.set(entry[1], entry[2]);
    }
    const session = meta.get('herdr_session'), workspace = meta.get('herdr_workspace_id'), tab = meta.get('herdr_tab_id'), pane = meta.get('herdr_pane_id');
    if (meta.get('backend') !== 'herdr') throw new Error('Терминал недоступен: переход поддерживается для Herdr.');
    if (meta.get('remote_host') || !['ship', 'scout'].includes(meta.get('kind') ?? '') || meta.get('endpoint_task_id') !== taskId || !atom(meta.get('spawn_gen')) ||
      !atom(session) || session!.includes(':') || !atom(workspace) || !atom(tab) || !atom(pane) || meta.get('window') !== `${session}:${pane}`) throw new Error('Терминал недоступен: не подтверждена привязка исполнителя к задаче.');
    const env = { ...environment };
    for (const name of Object.keys(env)) if (name.startsWith('HERDR_') && name !== 'HERDR_CONFIG_PATH') delete env[name];
    const native = async (args: string[]) => {
      const value = JSON.parse(await runner('herdr', [...args, '--session', session!], home, 10000, env));
      if (value.error) throw new Error('Herdr refused the request');
      return value.result;
    };
    const probe = async () => {
      try {
        const current = (await native(['pane', 'get', pane!]))?.pane;
        if (current?.pane_id !== pane || current?.tab_id !== tab || current?.workspace_id !== workspace || !atom(current?.terminal_id)) throw new Error(changed);
        const currentTab = (await native(['tab', 'get', tab!]))?.tab;
        // Native tab focus cannot select an arbitrary pane inside a split tab.
        if (currentTab?.tab_id !== tab || currentTab?.workspace_id !== workspace || currentTab?.pane_count !== 1) throw new Error('Терминал недоступен: вкладка изменилась или содержит несколько панелей.');
        return current.terminal_id as string;
      } catch (error: any) {
        if (error.message === changed || error.message.startsWith('Терминал недоступен:')) throw error;
        throw new Error('Терминал недоступен: Herdr не подтвердил сохранённую вкладку. Возможно, она закрыта.');
      }
    };
    const terminal = await probe();
    const token = createHash('sha256').update(JSON.stringify([home, taskId, source, terminal])).digest('hex');
    if (read() !== source || binding !== undefined && binding !== token) throw new Error(changed);
    if (binding !== undefined) {
      if (await probe() !== terminal || read() !== source) throw new Error(changed);
      try { await native(['tab', 'focus', tab!]); }
      catch { throw new Error('Не удалось выбрать терминал в Herdr. Повторите переход.'); }
    }
    return { available: true, binding: token };
  } catch (error: any) {
    if (binding !== undefined) throw error;
    return { available: false, reason: error.message };
  }
}
