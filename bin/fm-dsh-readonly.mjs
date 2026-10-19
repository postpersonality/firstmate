// DSH worker preload: reuse native credentials without mutating user stores.
// Only the child CLI receives --import; model tool processes do not inherit it.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const root = process.env.FM_DSH_PACKAGE_ROOT;
if (!root) throw new Error('DSH package root is required');
const refuse = () => { throw new Error('Firstmate refuses changes to native DSH settings or credentials'); };
const { default: Credentials } = await import(pathToFileURL(join(root, '../dsh-credentials-local/lib/index.js')));
for (const method of ['set', 'unset', 'write', 'modifyRecord', 'deleteRecord', 'migrateFlatDocument']) {
  Credentials.prototype[method] = refuse;
}
if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version === '0.1.5-rc.1') {
  const { default: Settings } = await import(pathToFileURL(join(root, '../dsh-settings-file/lib/index.js')));
  for (const method of ['persist', 'persistSection', 'prepareDocument']) Settings.prototype[method] = refuse;
}
// 0.2 Settings writes only the staged runtime home and its private profile.
if (process.env.FM_DSH_LEGACY_IMPORT_READY) {
  const { default: Settings } = await import(pathToFileURL(join(root, '../dsh-settings/lib/index.js')));
  const importLegacy = Settings.prototype.importLegacyDocument;
  Settings.prototype.importLegacyDocument = async function (...args) {
    const importing = existsSync(join(process.env.DSH_HOME, 'settings.yaml'));
    await importLegacy.apply(this, args);
    // A replacement Settings instance that sees the renamed file must not
    // announce completion while the original instance still imports sections.
    if (importing) writeFileSync(process.env.FM_DSH_LEGACY_IMPORT_READY, 'ready\n', { mode: 0o600 });
  };
}
