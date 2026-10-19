// DSH 0.1.5 worker preload: reuse native providers without mutating user stores.
// Only the child CLI receives --import; model tool processes do not inherit it.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = process.env.FM_DSH_PACKAGE_ROOT;
if (!root) throw new Error('DSH package root is required');
const refuse = () => { throw new Error('Firstmate refuses changes to native DSH settings or credentials'); };
const { default: Credentials } = await import(pathToFileURL(join(root, '../dsh-credentials-local/lib/index.js')));
for (const method of ['set', 'unset', 'write', 'modifyRecord', 'deleteRecord', 'migrateFlatDocument']) {
  Credentials.prototype[method] = refuse;
}
const { default: Settings } = await import(pathToFileURL(join(root, '../dsh-settings-file/lib/index.js')));
for (const method of ['persist', 'persistSection', 'prepareDocument']) Settings.prototype[method] = refuse;
