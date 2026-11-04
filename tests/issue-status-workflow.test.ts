import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = join(import.meta.dir, '../.github/workflows');
const workflow = (name: string): any => Bun.YAML.parse(readFileSync(join(dir, name), 'utf8'));
const evaluate = (expression: string, github: any, vars = {}) => Function('github', 'vars', 'format', `return (${expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')});`)(github, vars, (pattern: string, value: string) => pattern.replace('{0}', value));

test('closure job gates events, uses trusted code and shares frontend Board queue', () => {
  const job = workflow('add-to-project.yml').jobs['issue-status'];
  expect(job).toBeDefined();
  const github = { repository: 'Cringe-Driven-Development-Team/frontend', repository_owner: 'Cringe-Driven-Development-Team', event_name: 'issues', event: { action: 'closed', issue: { node_id: 'I_1' } } };
  for (const source of ['', 'webhook']) expect(evaluate(job.if, github, { TELEGRAM_EVENTS_SOURCE: source })).toBe(true);
  for (const changes of [{ event_name: 'pull_request' }, { repository_owner: 'other' }, { event: { action: 'opened' } }, { event: { action: 'reopened' } }]) {
    expect(evaluate(job.if, { ...github, ...changes })).toBe(false);
  }
  expect(evaluate(job.concurrency.group, github)).toBe('release-board');
  for (const id of ['I_2', 'I_3']) {
    expect(evaluate(job.concurrency.group, { ...github, repository: 'Cringe-Driven-Development-Team/backend', event: { issue: { node_id: id } } })).toBe(`issue-status-${id}`);
  }
  expect(job.concurrency.queue).toBe('max');
  expect(job.concurrency['cancel-in-progress']).toBe(false);
  const checkout = job.steps.find((step: any) => step.uses?.startsWith('actions/checkout@'));
  expect(checkout.with).toEqual({ repository: 'Cringe-Driven-Development-Team/.github', ref: 'main', path: 'automation', 'persist-credentials': false, token: '${{ secrets.ADD_TO_PROJECT_PAT }}' });
  const run = job.steps.find((step: any) => step.run);
  expect(run.run).toBe('bun automation/scripts/issue-status.ts');
  expect(run.env.ADD_TO_PROJECT_PAT).toBe('${{ secrets.ADD_TO_PROJECT_PAT }}');
  expect(workflow('automation.yml').on.issues.types).toContain('closed');
});

function validateQueue(workflow: any) {
  for (const block of [workflow.concurrency, ...Object.values(workflow.jobs ?? {}).map((job: any) => job.concurrency)]) {
    if (!block || typeof block === 'string' || !('queue' in block)) continue;
    if (!['single', 'max'].includes(block.queue)) throw Error('Invalid queue');
    if (block.queue === 'max' && block['cancel-in-progress'] !== false) throw Error('max requires cancel=false');
  }
}
test('every workflow queue is valid despite the narrow actionlint exception', () => {
  for (const path of readdirSync(dir).filter(path => /\.ya?ml$/.test(path))) validateQueue(workflow(path));
  for (const block of [{ queue: 'typo' }, { queue: 'max', 'cancel-in-progress': true }, { queue: 'max' }]) {
    expect(() => validateQueue({ concurrency: block })).toThrow();
    expect(() => validateQueue({ jobs: { test: { concurrency: block } } })).toThrow();
  }
});
