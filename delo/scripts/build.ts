import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
writeFileSync(new URL('../web/app.js', import.meta.url), stripTypeScriptTypes(readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8')));
