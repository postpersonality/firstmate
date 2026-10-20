import { z } from 'zod';

const linkError = 'Укажите одну ссылку на задачу Jira или конкретный pull request Bitbucket/GitHub';
// Only sources supported by the installed jira/bitbucket skills and gh-axi.
function reviewUrl(value: string): string | undefined {
  if (/\s/.test(value)) return;
  let url: URL; try { url = new URL(value); } catch { return; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
  const path = url.hostname === 'jira.example.invalid' ? /^\/browse\/[A-Z][A-Z0-9_]*-[1-9]\d*\/?$/.exec(url.pathname)?.[0].replace(/\/$/, '')
    : url.hostname === 'bitbucket.example.invalid' ? /^\/projects\/[A-Za-z0-9_~-]+\/repos\/[A-Za-z0-9_.-]+\/pull-requests\/[1-9]\d*(?=\/|$)/.exec(url.pathname)?.[0]
    : url.hostname === 'github.com' ? /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*(?=\/|$)/.exec(url.pathname)?.[0] : undefined;
  if (path) return `${url.origin}${path}`;
}

export const codeReviewInput = z.object({
  kind: z.literal('code'),
  url: z.string({ error: linkError }).trim().max(2000, linkError).transform((value, ctx) => {
    const canonical = reviewUrl(value);
    if (!canonical) { ctx.addIssue({ code: 'custom', message: linkError }); return z.NEVER; }
    return canonical;
  }),
  repo: z.string().max(500).default(''),
});
export type CodeReviewInput = z.infer<typeof codeReviewInput>;

// This is a dispatch brief for the agent; the HTTP server never reads remote sources or performs review.
export function codeReviewInstructions(input: CodeReviewInput, taskId: string, home: string) {
  return `Проведи код-ревью: ${input.url}
Используй существующий навык именно под именем code-review-workflow.
Прочти /home/user/Projects/my-skills/code-review-workflow/SKILL.md и следуй ему, включая необходимые ponytail, ponytail-review, codebase-design, jira, bitbucket и confluence; GitHub читай через gh-axi.
${input.repo ? `Контекстный проект (только чтение): ${input.repo}\n` : ''}Локальная review-задача Firstmate: ${taskId}; выбранный FM_HOME: ${home}.

Перед началом ревью извлеки связанные эпики и задачи на системную аналитику.
Для Jira читай только метаданные и отдельные поля через jira raw <KEY> --field <id>: summary, issuetype, issuelinks, parent, customfield_10008; каталог fields поможет проверить схему.
Для PR сначала прочти его метаданные и установи подтверждённые связанные Jira-задачи; заголовок или совпадение ключа сами по себе не доказывают связь.
Проверь тип и смысл каждой найденной связи. Не придумывай связи, не подменяй отсутствие доступа отсутствием эпика или СА; неоднозначность явно запиши как ограничение.
Добавь найденные ссылки на эпики и СА к описанию ЛОКАЛЬНОЙ review-задачи ${taskId}: через fm-tasks-axi.sh show прочти полный текущий body и через update --body-file сохрани его с добавленными ссылками, сохранив Дело:, Review: и исходные инструкции.
Эта запись относится только к бэклогу выбранного Firstmate home, не к описанию Jira или PR.

Затем выполни code-review-workflow: не меняй порядок источников и самостоятельные направления проверки.
Описания Jira-задач изначально игнорируй; не читай их как исходные требования. Исключение только для разрешения конкретного противоречия по правилу навыка.
СА - один из источников проверки соответствия требованиям, а не рамка всего ревью.
Работай только на чтение с внешними проектами, Jira и PR: не меняй код и статусы, не публикуй комментарии, не выполняй approve, worklog, переходы Jira или code-review-finalize.

Через существующие Firstmate status и отчёт фиксируй входную ссылку, текущую фазу (сбор контекста, ревью, перепроверка замечаний, отчёт), время начала и длительность фаз; не создавай новый исполнитель или БД задач.
Итог сохрани одним Markdown-отчётом data/${taskId}/report.md по структуре code-review-workflow: проверенные SHA, ссылки на задачу/PR/эпик/СА, доказанные замечания, покрытие, ограничения и отвергнутые подозрения.
Добавь явный вердикт с учётом ограничений: дефектов не найдено / нужны исправления / проверить не удалось; verdict не означает внешнее approve.
Приложи собственный report.md к локальной задаче штатным --report при её завершении; в status запиши итог и длительность, чтобы Дело показывало результат через существующий мониторинг.
`;
}
