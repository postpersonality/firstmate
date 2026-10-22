import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

// T-01/T-02: the one owner of artifact records, kept in the task's durable folder data/<task>/artifacts/<id>/.
// A record is artifact.json next to its copied source/; it becomes visible only when its folder is renamed in whole.
// completion.json is the immutable full answer and the archive mark; supplements/ and receipts/ sit beside it.
const maxFiles = 2000, maxBytes = 50 * 1024 * 1024;
export const artifactId = z.string().uuid('Недопустимый идентификатор материала');
const requestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, 'requestId: 1-128 символов A-Z a-z 0-9 . _ : -');
const submissionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/, 'Недопустимый идентификатор отправки');
export const completionInput = z.object({
  submissionId, comment: z.string().default(''), reason: z.string().default(''), payload: z.unknown().optional(),
  action: z.object({ kind: z.enum(['done', 'comment', 'interactive', 'irrelevant']), label: z.string().min(1).max(500) }),
}).strict();
export const supplementInput = z.object({ submissionId, comment: z.string().refine(v => v.trim() !== '', 'Напишите дополнение') }).strict();

export type ArtifactFile = { path: string; size: number; sha256: string };
export type Artifact = {
  id: string; requestId: string; kind: 'file' | 'url' | 'html'; title: string; action: string;
  source: { path?: string; root?: string; url?: string }; entry?: string; files: ArtifactFile[]; interactive: boolean;
  task: { id: string; title: string }; case?: { id: string; title: string }; project?: string; author: string; receivedAt: string; continues?: string;
};
export type Message = { submissionId: string; at: string; path: string; sha256: string; kind: 'completion' | 'supplement' };
export type Receipt = { requestId: string; savedAt: string; outcome?: string; noteId?: string; announced?: boolean | null; acknowledged?: boolean };
export type Provenance = Pick<Artifact, 'task' | 'case' | 'project' | 'author' | 'continues'>;

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
// Published only through link(), so a reader never sees a partial file and an existing one is never replaced.
function createOnce(path: string, data: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, data, { mode: 0o600 });
  try { linkSync(temp, path); return true; }
  catch (error: any) { if (error.code === 'EEXIST') return false; throw error; }
  finally { unlinkSync(temp); }
}
function replace(path: string, data: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, data, { mode: 0o600 }); renameSync(temp, path);
}

// Regular files under root; links and special files stay behind, as do .git and node_modules.
function walk(root: string, at = root, found: string[] = []) {
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const path = join(at, entry.name);
    if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') walk(root, path, found);
    else if (entry.isFile()) found.push(relative(root, path));
    if (found.length > maxFiles) throw new Error(`В папке материала больше ${maxFiles} файлов. Укажите --root с папкой только этого материала.`);
  }
  return found;
}
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..'; };

export class ArtifactStore {
  readonly home: string;
  constructor(home: string) { this.home = home; }
  private folder(taskId: string) { return join(this.home, 'data', taskId, 'artifacts'); }

  // Copies the material, then claims requestId; the same key with other content is refused, a lost acknowledgement replays.
  receive(input: { source: string; title: string; action: string; root?: string; requestId?: string } & Provenance) {
    const title = input.title.trim(), action = input.action.trim();
    if (!title || /[\r\n]/.test(title) || title.length > 300) throw new Error('Нужно название материала в одну строку до 300 символов');
    if (!action || action.length > 2000) throw new Error('Опишите, что требуется от пользователя (до 2000 символов)');
    const folder = this.folder(input.task.id); mkdirSync(join(folder, '.requests'), { recursive: true });
    const staging = join(folder, `.staging-${randomUUID()}`);
    try {
      const url = /^https?:\/\//i.test(input.source) ? new URL(input.source).href : undefined;
      let kind: Artifact['kind'] = 'url', entry: string | undefined, files: ArtifactFile[] = [], interactive = false, path: string | undefined, root: string | undefined;
      if (!url) {
        path = resolve(input.source);
        if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Файл материала не найден: ${path}`);
        kind = /\.html?$/i.test(path) ? 'html' : 'file';
        root = input.root ? resolve(input.root) : kind === 'html' ? dirname(path) : undefined;
        if (root && !inside(root, path)) throw new Error('Главный файл должен лежать внутри --root');
        if (root && lstatSync(path).isSymbolicLink()) throw new Error('Главный файл не может быть ссылкой');
        const names = root ? walk(root) : [basename(path)];
        entry = root ? relative(root, path) : basename(path);
        let total = 0;
        for (const name of names.sort()) {
          const data = readFileSync(root ? join(root, name) : path);
          total += data.length;
          if (total > maxBytes) throw new Error(`Материал больше ${maxBytes / 1024 / 1024} МиБ. Укажите --root с папкой только этого материала.`);
          const target = join(staging, 'source', name);
          mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, data, { mode: 0o600 });
          files.push({ path: name.split(sep).join('/'), size: data.length, sha256: sha256(data) });
          if (kind === 'html' && /\.(?:html?|m?js)$/i.test(name) && /queuePrompt|data-lavish-question/.test(data.toString('utf8'))) interactive = true;
        }
      }
      const content = { kind, title, action, url, entry, files, continues: input.continues };
      const fingerprint = sha256(JSON.stringify(content));
      const key = requestId.parse(input.requestId ?? `auto:${fingerprint}`);
      const claim = join(folder, '.requests', `${sha256(key)}.json`);
      let id: string = randomUUID();
      if (!createOnce(claim, JSON.stringify({ requestId: key, id, fingerprint }))) {
        const prior = readJson(claim);
        if (prior.fingerprint !== fingerprint) throw new Error(`requestId ${key} уже принят с другим материалом. Новая редакция публикуется с новым requestId.`);
        id = prior.id;
      }
      const target = join(folder, id);
      if (existsSync(join(target, 'artifact.json'))) return { id, outcome: 'replay' as const, path: target };
      const record: Artifact = { id, requestId: key, kind, title, action, source: { path, root, url }, entry, files, interactive, task: input.task, case: input.case, project: input.project, author: input.author, receivedAt: new Date().toISOString(), continues: input.continues };
      mkdirSync(staging, { recursive: true }); writeFileSync(join(staging, 'artifact.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
      try { renameSync(staging, target); }
      catch (error: any) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !existsSync(join(target, 'artifact.json'))) throw error; return { id, outcome: 'replay' as const, path: target }; }
      return { id, outcome: 'created' as const, path: target };
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }

  private find(id: string) {
    artifactId.parse(id);
    const data = join(this.home, 'data');
    for (const task of existsSync(data) ? readdirSync(data) : []) {
      const path = join(data, task, 'artifacts', id);
      if (existsSync(join(path, 'artifact.json'))) return path;
    }
    throw new Error('Материал не найден');
  }

  // One shared queue: every task folder's published records, with the state the queue and archive show.
  list() {
    const data = join(this.home, 'data'); const found = [];
    for (const task of existsSync(data) ? readdirSync(data) : []) {
      const folder = join(data, task, 'artifacts');
      if (!existsSync(folder)) continue;
      for (const name of readdirSync(folder)) {
        if (name.startsWith('.')) continue;
        try { found.push(this.summary(join(folder, name))); } catch { /* A folder without a whole record is not published. */ }
      }
    }
    return found;
  }
  private summary(path: string) {
    const artifact = readJson(join(path, 'artifact.json')) as Artifact;
    const completion = existsSync(join(path, 'completion.json')) ? readJson(join(path, 'completion.json')) : undefined;
    return { ...artifact, pinned: existsSync(join(path, 'pinned')), draft: !completion && existsSync(join(path, 'draft.json')), completedAt: completion?.completedAt as string | undefined, outcome: completion?.action as { kind: string; label: string } | undefined };
  }

  get(id: string) {
    const path = this.find(id);
    const read = (name: string) => existsSync(join(path, name)) ? readJson(join(path, name)) : undefined;
    const supplements = existsSync(join(path, 'supplements')) ? readdirSync(join(path, 'supplements')).filter(n => n.endsWith('.json')).map(n => readJson(join(path, 'supplements', n))).sort((a, b) => a.at.localeCompare(b.at)) : [];
    const receipts = Object.fromEntries((existsSync(join(path, 'receipts')) ? readdirSync(join(path, 'receipts')).filter(n => n.endsWith('.json')) : []).map(n => [n.slice(0, -5), readJson(join(path, 'receipts', n))]));
    return { ...this.summary(path), path, draftValue: read('draft.json'), completion: read('completion.json'), completionPath: join(path, 'completion.json'), supplements, receipts: receipts as Record<string, Receipt> };
  }

  // Only a recorded file is served, so a path outside source/ cannot be named.
  file(id: string, name: string) {
    const path = this.find(id); const artifact = readJson(join(path, 'artifact.json')) as Artifact;
    const file = artifact.files.find(f => f.path === name);
    if (!file) throw new Error('Материал не найден');
    return join(path, 'source', ...file.path.split('/'));
  }

  saveDraft(id: string, draft: unknown) {
    const path = this.find(id);
    if (existsSync(join(path, 'completion.json'))) throw new Error('Материал уже обработан; черновик не сохраняется');
    const savedAt = new Date().toISOString();
    replace(join(path, 'draft.json'), JSON.stringify({ savedAt, draft }));
    return { savedAt };
  }

  pin(id: string, on: boolean) {
    const path = this.find(id);
    if (on) writeFileSync(join(path, 'pinned'), ''); else rmSync(join(path, 'pinned'), { force: true });
    return { ok: true };
  }

  // T-05: one immutable record is the full answer and the archive mark; a repeat of its submissionId returns it.
  complete(id: string, input: unknown) {
    const path = this.find(id); const data = completionInput.parse(input);
    const file = join(path, 'completion.json');
    const record = { artifactId: id, submissionId: data.submissionId, completedAt: new Date().toISOString(), action: data.action, comment: data.comment, reason: data.reason, payload: data.payload };
    const created = createOnce(file, JSON.stringify(record, null, 2));
    const saved = readJson(file);
    if (saved.submissionId !== data.submissionId) throw Object.assign(new Error('Материал уже обработан другим ответом'), { status: 409 });
    return { outcome: created ? 'created' : 'replay', completion: saved, path: file, sha256: sha256(readFileSync(file)) };
  }

  // D-08: a supplement is its own message; the first answer and the archive state stay as they were.
  supplement(id: string, input: unknown) {
    const path = this.find(id); const data = supplementInput.parse(input);
    if (!existsSync(join(path, 'completion.json'))) throw new Error('Дополнить можно только отправленный ответ');
    mkdirSync(join(path, 'supplements'), { recursive: true });
    const file = join(path, 'supplements', `${data.submissionId}.json`);
    const created = createOnce(file, JSON.stringify({ artifactId: id, submissionId: data.submissionId, at: new Date().toISOString(), comment: data.comment }, null, 2));
    return { outcome: created ? 'created' : 'replay', supplement: readJson(file), path: file, sha256: sha256(readFileSync(file)) };
  }

  // Answers and supplements whose delivery to the Firstmate inbox has no receipt yet.
  undelivered() {
    return this.list().filter(a => a.completedAt).flatMap(a => {
      const { path, completion, completionPath, supplements, receipts, ...artifact } = this.get(a.id);
      const messages: Message[] = [{ submissionId: completion.submissionId, at: completion.completedAt, path: completionPath, sha256: sha256(readFileSync(completionPath)), kind: 'completion' }, ...supplements.map((s: any) => {
        const file = join(path, 'supplements', `${s.submissionId}.json`);
        return { submissionId: s.submissionId, at: s.at, path: file, sha256: sha256(readFileSync(file)), kind: 'supplement' as const };
      })];
      return messages.filter(m => !receipts[m.submissionId]).map(m => ({ artifact, completion, message: m }));
    });
  }

  receipt(id: string, submission: string, receipt: Receipt) {
    const path = this.find(id); mkdirSync(join(path, 'receipts'), { recursive: true });
    createOnce(join(path, 'receipts', `${submissionId.parse(submission)}.json`), JSON.stringify(receipt, null, 2));
  }
}

// Paths of artifact files to the content types the desk can show; anything else downloads.
export const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};
export const contentType = (name: string) => contentTypes[extname(name).toLowerCase()];
