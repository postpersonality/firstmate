import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function reviewConfig(home = process.env.DELO_FIRSTMATE_HOME || process.env.FM_HOME || fileURLToPath(new URL('../..', import.meta.url))) {
  try {
    return JSON.parse(readFileSync(resolve(home, 'config/delo-review.json'), 'utf8')) as { jiraHost?: string; bitbucketHost?: string; saReviewCwd?: string; codeReviewSkill?: string };
  } catch (error: any) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}
