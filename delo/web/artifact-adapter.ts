// T-04: runs first inside a sandboxed artifact frame. It offers the narrow window.lavish a material's own form uses
// (queuePrompt, sendQueuedPrompts) and reports control values so the desk keeps the draft; nothing else of the Lavish SDK.
(() => {
  type Prompt = { prompt: string; tag?: string; text?: string; queueKey?: string; data?: unknown };
  type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const queue: Prompt[] = [];
  const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let label = '', restoring = false, timer: ReturnType<typeof setTimeout> | undefined;
  const post = (message: object) => parent.postMessage({ type: 'delo-artifact', ...message }, '*');
  const checkable = (c: Control): c is HTMLInputElement => c instanceof HTMLInputElement && (c.type === 'radio' || c.type === 'checkbox');
  const controls = () => [...document.querySelectorAll<Control>('input, textarea, select')].filter(c => !['button', 'submit', 'reset', 'file', 'hidden', 'password', 'image'].includes(c.type));
  const key = (c: Control, index: number) => [c.closest('[data-lavish-question]')?.getAttribute('data-lavish-question') ?? '', c.name || c.id || `#${index}`, checkable(c) ? c.value : ''].join('|');
  const fields = () => Object.fromEntries(controls().map((c, i) => [key(c, i), checkable(c) ? c.checked : c.value]));
  const draft = () => { clearTimeout(timer); timer = setTimeout(() => post({ kind: 'draft', fields: fields(), prompts: queue }), 400); };

  (window as any).lavish = {
    queuePrompt(prompt: string | (Prompt & { element?: Element }), options: Partial<Prompt> & { element?: Element } = {}) {
      const given = typeof prompt === 'string' ? { ...options, prompt } : { ...prompt };
      const queueKey = given.queueKey ?? given.element?.closest('[data-lavish-question]')?.getAttribute('data-lavish-question') ?? undefined;
      const item: Prompt = { prompt: String(given.prompt ?? ''), tag: given.tag, text: given.text, queueKey, data: given.data };
      const at = queueKey ? queue.findIndex(p => p.queueKey === queueKey) : -1;
      if (at >= 0) queue[at] = item; else queue.push(item);
      draft();
      return queue.length;
    },
    sendQueuedPrompts() {
      const request = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      post({ kind: 'send', request, prompts: queue, fields: fields(), label });
      return new Promise((resolve, reject) => waiting.set(request, { resolve, reject }));
    },
  };

  // The desk names the answer by the button that sent it.
  document.addEventListener('click', event => {
    const button = (event.target as Element | null)?.closest?.('button, input[type=submit], input[type=button]');
    if (button) label = (button.textContent || (button as HTMLInputElement).value || '').trim().slice(0, 200);
  }, true);
  for (const type of ['input', 'change']) document.addEventListener(type, () => { if (!restoring) draft(); }, true);

  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'delo-artifact') return;
    const data = event.data;
    if (data.kind === 'restore') {
      restoring = true;
      try {
        const saved = data.fields ?? {};
        controls().forEach((c, i) => {
          const value = saved[key(c, i)];
          if (value === undefined) return;
          if (checkable(c)) c.checked = value === true; else c.value = String(value);
          c.dispatchEvent(new Event('input', { bubbles: true })); c.dispatchEvent(new Event('change', { bubbles: true }));
        });
        queue.splice(0, queue.length, ...(Array.isArray(data.prompts) ? data.prompts : []));
      } finally { restoring = false; }
    }
    if (data.kind === 'sent') {
      const pending = waiting.get(data.request); waiting.delete(data.request);
      if (data.ok) { queue.length = 0; pending?.resolve({ ok: true }); } else pending?.reject(new Error(data.error || 'Ответ не отправлен'));
    }
  });
  addEventListener('load', () => post({ kind: 'ready' }));
})();
