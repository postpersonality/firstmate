import { parseArgs } from 'node:util';
import { Store } from './store.ts';
import { id } from './model.ts';

const help = `Дело — карта задач Firstmate в браузере. Агентов запускает Firstmate.
Новую задачу из терминала заводит fm-tasks-axi.sh add.

delo serve [--port 4317]              Карта задач в браузере
delo list                           Список задач
delo show <задача>                   Задача целиком (JSON)
delo state <задача> active|paused|done|dropped
delo doctor                         Проверить локальные возможности
delo publish-artifact <файл|URL> --title <название> --action <что требуется> [--task <задача>] [--root <папка>] [--request-id <ключ>]
                                    Сдать материал на просмотр: копия с ресурсами попадает в очередь «На просмотр».
                                    HTML копируется со своей папкой (или --root), другой файл - один; URL остаётся ссылкой.
                                    Задача по умолчанию - FM_TASK_ID; дело и автора Дело берёт из записей Firstmate.
                                    Повтор с тем же материалом безопасен; новая редакция - новая публикация.

--firstmate-home /путь задаёт хранилище Firstmate.
По умолчанию: DELO_FIRSTMATE_HOME или ../../firstmate от папки проекта.
--home и DELO_HOME устарели и игнорируются: материалы Дело хранит в папках задач Firstmate.`;

async function main() {
  // --home stays accepted so old service units keep starting; its value is never used.
  const { values: flags, positionals: p } = parseArgs({ allowPositionals: true, options: {
    home: { type: 'string' }, 'firstmate-home': { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    title: { type: 'string' }, action: { type: 'string' }, task: { type: 'string' }, root: { type: 'string' }, 'request-id': { type: 'string' },
  }, strict: false });
  if (flags.help || p[0] === 'help') { console.log(help); return; }
  const store = new Store({ firstmateHome: flags['firstmate-home'] ? String(flags['firstmate-home']) : undefined });
  const command = p[0] || 'serve'; const target = p[1];
  const goal = () => { if (!target) throw new Error('Укажите задачу'); id.parse(target); return target; };
  switch (command) {
    case 'serve': {
      const port = Number(flags.port ?? 4317); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Порт должен быть от 1 до 65535');
      const { serve } = await import('./server.ts'); serve(store, port); break;
    }
    case 'list': console.log(store.list().map(g => `${g.id}\t${g.state}\t${g.title}`).join('\n')); break;
    case 'show': console.log(JSON.stringify(store.get(goal()), null, 2)); break;
    case 'state': console.log(JSON.stringify(store.update(goal(), { state: p[2] }), null, 2)); break;
    case 'doctor': console.log(JSON.stringify({ Node: process.version, firstmateHome: store.firstmate.home, commits: 'Не запускаются', sync: 'Не запускается' }, null, 2)); break;
    case 'publish-artifact': {
      const text = (name: string) => typeof flags[name] === 'string' ? String(flags[name]) : undefined;
      const taskId = text('task') ?? process.env.FM_TASK_ID;
      if (!target || !text('title') || !text('action') || !taskId) throw new Error('Укажите файл или URL, --title, --action и --task (или FM_TASK_ID)');
      console.log(JSON.stringify(store.publishArtifact({ source: target, title: text('title')!, action: text('action')!, root: text('root'), requestId: text('request-id'), taskId }), null, 2)); break;
    }
    default: throw new Error(`Неизвестная команда: ${command}. delo --help`);
  }
}

main().catch(error => { console.error(`Дело: ${error.message}`); process.exitCode = 1; });
