import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeReviewInput, codeReviewInstructions } from '../src/code-review.ts';
import { reviewConfig } from '../src/review-config.ts';

test('private review configuration selects exact hosts and supplies local runner paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'delo-private-config-'));
  const previous = process.env.DELO_FIRSTMATE_HOME;
  try {
    mkdirSync(join(home, 'config'));
    writeFileSync(join(home, 'config/delo-review.json'), JSON.stringify({ jiraHost: 'jira.private.invalid', bitbucketHost: 'git.private.invalid', saReviewCwd: '/tmp/sa-example', codeReviewSkill: '/tmp/skill/SKILL.md' }));
    process.env.DELO_FIRSTMATE_HOME = home;
    assert.equal(reviewConfig(home).saReviewCwd, '/tmp/sa-example');
    assert.equal(codeReviewInput.parse({ kind: 'code', url: 'https://jira.private.invalid/browse/EXAMPLE-1' }).url, 'https://jira.private.invalid/browse/EXAMPLE-1');
    assert.equal(codeReviewInput.safeParse({ kind: 'code', url: 'https://jira.private.invalid.evil/browse/EXAMPLE-1' }).success, false);
    assert.equal(codeReviewInput.parse({ kind: 'code', url: 'https://git.private.invalid/projects/DEMO/repos/test/pull-requests/2' }).url, 'https://git.private.invalid/projects/DEMO/repos/test/pull-requests/2');
    assert.match(codeReviewInstructions({kind:'code',url:'https://github.com/a/b/pull/1',repo:''}, 't1', home), /\/tmp\/skill\/SKILL\.md/);
  } finally {
    if (previous === undefined) delete process.env.DELO_FIRSTMATE_HOME; else process.env.DELO_FIRSTMATE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
