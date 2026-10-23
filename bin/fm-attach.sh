#!/usr/bin/env bash
# Привязка явно выбранного существующего Herdr агента; FM_HOME обязателен.
#
# Usage: fm-attach.sh discover --session <name>
#        fm-attach.sh inspect --session <name> --pane <pane> --pid <pid>
#                           [--parent-record <AGY-launcher-json> --native-session <known-parent-id>]
#        fm-attach.sh attach <task> --selection <inspect-json> --source-file <поручение>
#                           --dod-file <критерии> --title <название> [--context <контекст>]
#                           [--case <открытое-дело>] [--human-required]
#                           [--observe-file <выбранный-файл>] [--existing-check <id>]
#        fm-attach.sh verify|state|observe|exit-gate <task>
#        fm-attach.sh receipt <task> --file <источник-ответа> --token <точный-маркер>
#                           --format pi|ack-file [--ack <точная-фраза-ответа>]
#        fm-attach.sh dod <task> propose|confirm|achieve|accept --file <источник>
#                           [--version <версия>] [--human-required]
#        fm-attach.sh snapshot
#
# inspect/discover только читают процессы и регистрацию, без переписки и ввода.
# Сохраните inspect JSON, затем передайте его attach с источником явного поручения.
# source-file хранится как ссылка и hash. Повтор с тем же task/identity/source/case
# идемпотентен; частичная регистрация восстанавливается тем же вызовом.
# Новый процесс требует нового явного поручения и нового task id; старая связь
# и дело сохраняются. Идентичность не заменяется по адресу панели или cwd.
# Доказанная смена native session оставляет revision-bound loss receipt; возврат
# к прежней сессии не восстанавливает поручение. Read failure остаётся unknown.
# Отдельный state/<task>.external.json не создаёт .meta, spawn_gen или worktree.
# Дело создаётся через backlog owner с детерминированным external-<task> id;
# task-body хранит единственный DoD с версией, точным ответом и доказательствами.
# propose сбрасывает прежние подтверждения; confirm фиксирует ответ пользователя,
# achieve - проверенные результаты, accept - человеческую приёмку, если она нужна.
# confirm/achieve/accept требуют точную --version; native done/idle её не заменяет.
# exit-gate проверяет эти свидетельства, а fm-control exit проверяет сам процесс.
# receipt pi требует assistant-ответ из привязанного native session, не user prompt.
# ack-file требует проверенную точную фразу ответа, отличную от исходного token.
# --existing-check сохраняет уже зарегистрированный observer без нового check.
# --observe-file добавляет выбранные результаты в change-check; Pi path включён сам.
# observe - обычный зарегистрированный watcher-check: неизменённый срез молчит,
# изменившийся возвращает путь результата. Проверка receipt не отправляет handshake.
# Неподтверждённый DoD не мешает attach. Остановка не закрывает дело автоматически.
# send/control остаются в fm-send/fm-control; relaunch/teardown не разрешаются.
# Поддержанная точная процессная проверка требует Linux /proc; неизвестное состояние
# запрещает ввод. AGY child hooks не заменяют parent identity из launcher-record.
# Терминальный API не даёт атомарной доставки PID: guard выполняется перед каждым
# вводом текста/клавиши, но остаётся интервал между проверкой и действием API.
# Лабораторные вызовы идут только через fm-herdr-lab.sh run с явной session.
set -eu
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
  --help|-h) sed -n '2,${/^#/!q;p;}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
case "${1:-}" in
  attach|receipt|dod|observe)
    # shellcheck source=bin/fm-gate-refuse-lib.sh
    . "$SCRIPT_DIR/fm-gate-refuse-lib.sh"
    fm_refuse_if_gate_agent
    ;;
esac
exec python3 "$SCRIPT_DIR/fm-external-session.py" "$@"
