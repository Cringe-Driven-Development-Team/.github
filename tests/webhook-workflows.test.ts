import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const workflow = (name: string): any => Bun.YAML.parse(readFileSync(join(root, '.github/workflows', `${name}.yml`), 'utf8'));
// These job predicates use boolean operators/property access shared with JS.
// Empty vars match Actions' unset variables; comparisons ignore string case.
function enabled(expression: string | undefined, github: any, source = ''): boolean {
  if (expression === undefined) return true;
  const raw = expression.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, '');
  return Boolean(Function('github', 'vars', `return (${raw});`)(github, { TELEGRAM_EVENTS_SOURCE: source.toLowerCase() }));
}

test('webhook switch suppresses event notification while board, closing and reminders remain available', () => {
  const notify = workflow('telegram').jobs.notify;
  const board = workflow('add-to-project').jobs;
  const caller = workflow('automation').jobs;
  const reminders = workflow('reminders').jobs.remind;
  const issue = { event_name: 'issues', event: { action: 'opened' } };
  const merged = { event_name: 'pull_request', event: { action: 'closed', pull_request: { merged: true, base: { ref: 'main' } }, repository: { default_branch: 'main' } } };
  for (const [source, sends] of [['', true], ['actions', true], ['other', true], ['webhook', false], ['WEBHOOK', false]] as const) {
    expect(enabled(notify.if, issue, source)).toBe(sends);
    expect(enabled(caller.board.if, issue, source)).toBe(true);
    expect(enabled(caller.telegram.if, issue, source)).toBe(true);
    expect(enabled(board['add-to-project'].if, issue, source)).toBe(true);
    expect(enabled(board.close.if, merged, source)).toBe(true);
    expect(enabled(reminders.if, { event_name: 'schedule', event: {} }, source)).toBe(true);
    expect(enabled(reminders.if, { event_name: 'workflow_dispatch', event: {} }, source)).toBe(true);
  }
});

test('image publication is restricted to main pushes with package write permission', () => {
  const image = workflow('webhook-alerts-image');
  expect(Object.keys(image.on)).toEqual(['push']);
  expect(image.on.push.branches).toEqual(['main']);
  expect(image.permissions).toEqual({ contents: 'read', packages: 'write' });
  const job = image.jobs.publish;
  const trusted = { repository: 'Cringe-Driven-Development-Team/.github', event_name: 'push', ref: 'refs/heads/main' };
  expect(enabled(job.if, trusted)).toBe(true);
  for (const change of [{ event_name: 'pull_request' }, { ref: 'refs/heads/topic' }, { repository: 'other/.github' }]) {
    expect(enabled(job.if, { ...trusted, ...change })).toBe(false);
  }
});
