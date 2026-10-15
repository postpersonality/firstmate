# Duty scouts

A duty is a read-only scout over a product folder.
Its backlog task body names the folder in a `Папка: <absolute path>` line, the scout reads that folder and never writes in it, and the report is the whole deliverable.
[`bin/fm-spawn.sh --help`](../bin/fm-spawn.sh) owns how the folder is kept read-only, and [`bin/fm-brief.sh --help`](../bin/fm-brief.sh) owns the matching worker instructions.

## Firstmate

- A start request for a scout task is a duty when the body that `bin/fm-tasks-axi.sh show <id>` prints has a `Папка:` line; that line names the folder.
- Scaffold the brief with `bin/fm-brief.sh <id> firstmate --scout --read-only-dir <path>` and paste the scout block below verbatim into its `## Firstmate spec`.
- Spawn it on the host project with `bin/fm-spawn.sh <id> projects/firstmate --scout --read-only-dir <path>`.
  The flag works only on the claude harness, so a dispatch profile that resolves elsewhere is a blocker to report, never a reason to drop the flag.
- When the duty reports, read `data/<id>/report.md`, run `bin/fm-captain-hold.sh complete <id> --none` because its drafts are not captain calls, and clean up as `scout-completion` describes, with the report as the Done artifact.
- Do not retell the report or remind the captain about it in chat; for a duty this replaces the finished-findings relay of `AGENTS.md` section 9 and of `scout-completion`.

## Scout block

Everything inside this fence is pasted as is; it speaks to the duty scout.

````text
Duty rules:
- The thread link is in the task body.
  Read the thread and its posts only with the `loop-msg` skill's read scripts, and never run one of its sending scripts.
- `get_post.ts` prints `post:<id>  thread:<root_id||id>  channel:<channel_id>`; take the root post and the channel for your draft from that line.
- Write your report at the path this brief names (`data/<task-id>/report.md`) in this form, and publish, post or create nothing yourself:

```
## Ответ в тред (черновик)
Тред: <ссылка>; корневой пост: <root_id>; канал: <channel_id>
<текст ответа>

## Задача Jira (черновик)
Проект: <ключ>; Тип: Bug; Приоритет: <...>; Платформа: <если нужна проекту>
Заголовок: <...>
Описание (разметка Jira): Окружение / Шаги / Фактический результат / Ожидаемый результат / Доказательства (файл:строка, коммит)
```

- Include the `## Задача Jira (черновик)` section only when you found a defect, and shape its description with the `write-bug-task` and `write-jira-format` skills.
````
