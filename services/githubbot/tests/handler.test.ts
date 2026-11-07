import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeUpdate, type Command, type Context, type Input } from '../src/commands';
import { ApiError } from '../src/github';
import { handleJob, type HandlerDeps } from '../src/handler';
import type { Outgoing } from '../src/messages';
import { openStore } from '../src/store';
import { apiDoubles, bot, callback, config } from './fixtures';

let directory: string, path: string, deps: HandlerDeps, api: ReturnType<typeof apiDoubles>;
let sent: { context: Context; message: Outgoing }[], answers: { id: string; text: string }[];
let now: number;
let diagnostics: string[], restoreDiagnostics: () => void;
const issueCommand: Command = { name: 'issue', title: 'X', body: '' };
const input = (command: Command = issueCommand, id = 1, threadId = 11): Input => ({
  kind: 'command', updateId: id, actor: { id: '101', username: 'alice' },
  context: { chatId: '-1001', threadId, messageId: 10 }, command,
});
const run = async (value: Input) => { deps.store.ingest([value], value.updateId + 1); await handleJob(deps.store.job(value.updateId), deps); };
const resume = async (id = 1) => handleJob(deps.store.job(id), deps);
const reopen = () => { deps.store.close(); deps.store = openStore(path); deps.store.recover(); };
const choice = (id = 2, actor = '101', promptMessageId = 20): Input => ({
  kind: 'choice', updateId: id, actor: { id: actor, username: actor === '101' ? 'alice' : 'bob' },
  context: { chatId: '-1001', threadId: 14, messageId: promptMessageId },
  callbackId: `callback-${id}`, requestId: deps.store.job(1).choiceId!, repoIndex: 0, promptMessageId,
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'githubbot-handler-')); path = join(directory, 'journal.sqlite');
  api = apiDoubles(); sent = []; answers = []; now = Date.parse('2026-11-07T09:00:00Z');
  diagnostics = [];
  const log = spyOn(console, 'error').mockImplementation((message: unknown) => { diagnostics.push(String(message)); });
  restoreDiagnostics = () => log.mockRestore();
  deps = { config: config(), store: openStore(path), github: api.github, projects: api.projects,
    send: async (context, message) => { sent.push({ context, message }); return 20 + sent.length - 1; },
    answerCallback: async (id, text) => { answers.push({ id, text }); }, now: () => new Date(now) };
});
afterEach(() => { restoreDiagnostics(); deps.store.close(); rmSync(directory, { recursive: true, force: true }); });

test('topic 11 creates exactly one prefixed backend issue and delivers saved URL after restart', async () => {
  await run(input()); reopen(); await resume();
  expect(api.createCalls).toEqual([{ repo: 'backend', title: 'Backend. X', body: '' }]);
  expect(api.initializedIssues).toHaveLength(1);
  expect(sent.at(-1)?.message.html).toContain('/backend/issues/1');
  expect(deps.store.job(1).phase).toBe('done');
});

test('topic 14 prompts, refuses other owner/wrong prompt and duplicate callback never executes original', async () => {
  deps.config.users.push({ telegramId: '102', username: 'bob', githubLogin: 'other' });
  await run(input(issueCommand, 1, 14));
  expect(api.createCalls).toHaveLength(0); expect(sent[0]?.message.keyboard).toHaveLength(3);
  await run(choice(2, '102')); await run(choice(3, '101', 21));
  expect(answers).toHaveLength(2); expect(api.createCalls).toHaveLength(0);
  expect(deps.store.job(1).phase).toBe('waiting_repo');
  await run(choice(4)); expect(deps.store.job(1).phase).toBe('ready');
  expect(api.createCalls).toHaveLength(0); await resume(); reopen();
  await run(choice(5)); await resume();
  expect(api.createCalls).toHaveLength(1); expect(answers).toHaveLength(4);
});

test('unsent prepared prompt uses saved repository order after config reorder', async () => {
  const value = input(issueCommand, 1, 14); deps.store.ingest([value], 2);
  deps.store.createChoice(1, ['frontend', 'backend'], now + 86_400_000); reopen();
  deps.config.repositories.reverse(); await resume();
  expect(sent[0]?.message.keyboard?.map(row => row[0]?.text)).toEqual(['frontend', 'backend']);
  await run(choice()); await resume(); expect(api.createCalls[0]?.repo).toBe('frontend');
});

test('chosen repository removed from allowlist is rejected', async () => {
  await run(input(issueCommand, 1, 14)); await run(choice());
  deps.config.repositories = deps.config.repositories.filter(r => r.name !== 'backend');
  await resume(); expect(api.createCalls).toHaveLength(0); expect(sent.at(-1)?.message.html).toMatch(/репозитори/);
});

test('saved callback index still resolves when current repository list shrinks', async () => {
  await run(input(issueCommand, 1, 14));
  deps.config.repositories = deps.config.repositories.filter(repo => repo.name === 'figma'); reopen();
  const value = decodeUpdate(callback(deps.store.job(1).choiceId!, 2), deps.config, bot)!;
  await run(value); await resume();
  expect(api.createCalls).toEqual([{ repo: 'figma', title: 'Figma. X', body: '' }]);
});

test.each(['rejected', 'retryable'] as const)('Projects %s failure returns known created issue without retrying initialization', async kind => {
  deps.projects.initializeIssue = async issue => { api.initializedIssues.push(issue); throw new ApiError('github', kind, 'board failed'); };
  await run(input()); reopen(); await resume();
  expect(api.createCalls).toHaveLength(1); expect(api.initializedIssues).toHaveLength(1);
  expect(sent.at(-1)?.message.html).toContain('создана'); expect(sent.at(-1)?.message.html).toContain('/backend/issues/1');
});

test('known issue recovered before initialization returns partial URL without resetting human Status', async () => {
  const value = input(); deps.store.ingest([value], 2);
  const issue = await api.github.createIssue('backend', 'Backend. X', '');
  deps.store.checkpoint(1, { phase: 'issue_created', issue }); reopen(); await resume();
  expect(api.initializedIssues).toHaveLength(0); expect(api.createCalls).toHaveLength(1);
  expect(sent.at(-1)?.message.html).toContain('/backend/issues/1');
});

test('transient outbox checkpoint failure retains partial known issue URL', async () => {
  const checkpoint = deps.store.checkpoint; let writes = 0;
  deps.store.checkpoint = (id, patch) => {
    if (patch.output && ++writes <= 2) throw new Error('temporary local write failure');
    checkpoint(id, patch);
  };
  await run(input());
  expect(api.createCalls).toHaveLength(1); expect(sent[0]?.message.html).toContain('/backend/issues/1');
});

test('initialization failure logs sanitized command ID and stage', async () => {
  deps.projects.initializeIssue = async () => { throw new ApiError('github', 'rejected', 'secret upstream data'); };
  await run(input());
  expect(diagnostics).toEqual(['GitHubBot job 1: issue_created initialization failed']);
});

test('uncertain creation warns across recovery and never performs another GitHub request', async () => {
  deps.github.createIssue = async (repo, title, body) => { api.createCalls.push({ repo, title, body }); throw new ApiError('github', 'uncertain', 'lost response'); };
  await run(input()); reopen(); await resume();
  expect(api.createCalls).toHaveLength(1); expect(api.initializedIssues).toHaveLength(0);
  expect(sent[0]?.message.html).toMatch(/неизвестен/); expect(deps.store.nextJob(now)).toBeNull();
});

test.each(['issue', 'close', 'assign'] as const)('failed send of %s retries only delivery after restart', async name => {
  const issue = api.seed(); let sends = 0;
  deps.send = async (context, message) => { if (++sends === 1) throw new ApiError('telegram', 'retryable', 'offline', 8000); sent.push({ context, message }); return 20; };
  await run(input(name === 'issue' ? issueCommand : { name, target: issue.ref, ...(name === 'assign' ? { username: 'alice' } : {}) }));
  expect(deps.store.job(1).phase).toBe('reply_pending'); expect(deps.store.job(1).nextAttemptAt).toBe(now + 8000);
  const calls = api.createCalls.length + api.mutations.length; reopen(); now += 8000; await resume();
  expect(api.createCalls.length + api.mutations.length).toBe(calls); expect(sent).toHaveLength(1);
});

test('failed prompt send remains reply_pending and binds only delivered prompt', async () => {
  deps.send = async () => { throw new ApiError('telegram', 'retryable', 'offline'); };
  await run(input(issueCommand, 1, 14)); expect(deps.store.job(1).phase).toBe('reply_pending');
  await run(choice()); expect(deps.store.job(1).phase).toBe('reply_pending');
  deps.send = async (context, message) => { sent.push({ context, message }); return 20; };
  reopen(); now += 5000; await resume(); expect(deps.store.job(1).phase).toBe('waiting_repo');
  await run(choice(3)); expect(deps.store.job(1).phase).toBe('ready');
});

test('crash after binding prompt recovers waiting choice without resending or rebinding', async () => {
  deps.store.ingest([input(issueCommand, 1, 14)], 2);
  const requestId = deps.store.createChoice(1, ['backend'], now + 86_400_000);
  deps.store.checkpoint(1, { phase: 'reply_pending', output: [{ html: 'Выберите репозиторий' }], nextOutput: 0 });
  deps.store.bindPrompt(requestId, 20); reopen(); await resume();
  expect(sent).toHaveLength(0); expect(deps.store.job(1)).toMatchObject({ phase: 'waiting_repo', nextOutput: 1 });
  await run(choice()); expect(deps.store.job(1).phase).toBe('ready');
});

test.each(['close', 'assign', 'assignme', 'unassign', 'tosprint'] as const)('%s performs intended mutation and reads before recovery replay', async name => {
  const issue = api.seed(); if (name === 'unassign') issue.assignees = ['octo'];
  const value = input({ name, target: issue.ref, ...(['assign', 'unassign'].includes(name) ? { username: 'alice' } : {}) });
  await run(value); const calls = api.mutations.length; expect(calls).toBe(1);
  deps.store.checkpoint(1, { phase: 'mutating', output: undefined, nextOutput: 0 }); reopen(); await resume();
  expect(api.mutations).toHaveLength(1);
  expect(sent.at(-1)?.message.html).toContain(issue.ref.url);
});

test('tosprint reports actual externally changed Status', async () => {
  const issue = api.seed();
  deps.projects.toCurrentSprint = async () => ({ item: { id: 'P1', issue, archived: false, sprintId: 'S1', status: 'Done' },
    iteration: api.board.iterations[0]!, statusChangedExternally: true });
  await run(input({ name: 'tosprint', target: issue.ref }));
  expect(sent[0]?.message.html).toContain('Done'); expect(sent[0]?.message.html).toMatch(/измен/);
});

test('assignment permission denial explains failure without mutation', async () => {
  const issue = api.seed(); deps.github.canAssign = async () => false;
  await run(input({ name: 'assign', target: issue.ref, username: 'alice' }));
  expect(api.mutations).toHaveLength(0); expect(sent[0]?.message.html).toMatch(/назнач/);
});

test('unknown and observed stale aliases cannot mutate after restart; assignme still uses ID', async () => {
  const issue = api.seed();
  await run(input({ name: 'assign', target: issue.ref, username: 'unknown' }));
  const changed = input({ name: 'sprint' }, 2); changed.actor.username = 'alice_new'; await run(changed); reopen();
  await run(input({ name: 'assign', target: issue.ref, username: 'alice' }, 3));
  expect(api.mutations).toHaveLength(0);
  const self = input({ name: 'assignme', target: issue.ref }, 4); self.actor.username = 'alice_new'; await run(self);
  expect(api.mutations).toEqual(['assign:octo']);
});

test.each(['unknown actor', 'anonymous actor', 'foreign group'])('%s cannot mutate or see summaries even from reply_pending', async reason => {
  const value = input({ name: 'sprint' });
  if (reason === 'unknown actor') value.actor.id = '999';
  if (reason === 'anonymous actor') value.actor.id = '';
  if (reason === 'foreign group') value.context.chatId = '-999';
  deps.store.ingest([value], 2); deps.store.checkpoint(1, { phase: 'reply_pending', output: [{ html: 'secret summary' }] });
  await resume(); expect(sent).toHaveLength(0); expect(api.mutations).toHaveLength(0); expect(deps.store.job(1).phase).toBe('done');
});

test('argument errors are delivered as escaped hints without GitHub', async () => {
  const value: Input = { ...input(), kind: 'error', message: 'Формат: <title>' }; await run(value);
  expect(sent[0]?.message.html).toContain('&lt;title&gt;'); expect(api.createCalls).toHaveLength(0);
});

test.each([undefined, 'alice'])('sprint %s returns current summary including closed issues', async username => {
  const issue = api.seed(); issue.state = 'CLOSED'; issue.assignees = ['octo'];
  api.board.items.push({ id: 'P1', issue, sprintId: 'S1', archived: false, status: 'Done' });
  await run(input({ name: 'sprint', ...(username ? { username } : {}) }));
  expect(sent[0]?.message.html).toContain('Уникальных задач: 1'); expect(sent[0]?.message.html).toContain('CLOSED');
});

test('retryable reads are bounded at three attempts and persist backoff', async () => {
  let calls = 0; deps.projects.readBoard = async () => { calls++; throw new ApiError('github', 'retryable', 'offline'); };
  await run(input({ name: 'sprint' })); expect(deps.store.job(1)).toMatchObject({ attempts: 1, nextAttemptAt: now + 5000 });
  now += 5000; await resume(); now += 5000; reopen(); await resume();
  expect(calls).toBe(3); expect(deps.store.job(1).phase).toBe('done'); expect(sent[0]?.message.html).toMatch(/ошибка/i);
});

test('stale alias discovered after a saved summary prevents replaying that summary', async () => {
  deps.store.ingest([input({ name: 'sprint', username: 'alice' })], 2);
  deps.store.checkpoint(1, { phase: 'reply_pending', output: [{ html: 'private saved summary' }] });
  const renamed = input({ name: 'sprint' }, 2); renamed.actor.username = 'alice_new'; await run(renamed);
  sent.length = 0; reopen(); await resume();
  expect(sent).toHaveLength(1); expect(sent[0]?.message.html).toContain('устарел');
  expect(sent[0]?.message.html).not.toContain('private saved summary');
});

test('unconfirmed creating checkpoint recovered by Store only warns', async () => {
  deps.store.ingest([input()], 2); deps.store.checkpoint(1, { phase: 'creating' });
  reopen(); await resume();
  expect(api.createCalls).toHaveLength(0); expect(sent[0]?.message.html).toContain('неизвестен');
});

test('known safe create rate limit retries after saved delay and creates once', async () => {
  const create = deps.github.createIssue; let attempts = 0;
  deps.github.createIssue = async (...args) => { if (++attempts === 1) throw new ApiError('github', 'retryable', 'limited', 9000); return create(...args); };
  await run(input()); expect(deps.store.job(1)).toMatchObject({ phase: 'ready', attempts: 1, nextAttemptAt: now + 9000 });
  await resume(); expect(attempts).toBe(1); reopen(); now += 9000; await resume();
  expect(attempts).toBe(2); expect(api.createCalls).toHaveLength(1);
});

test('summary resumes at unsent message without rereading board', async () => {
  deps.config.users.push({ telegramId: '102', username: 'bob', githubLogin: 'other' });
  for (const [number, login] of [[1, 'octo'], [2, 'other']] as const) {
    const issue = api.seed('backend', number); issue.assignees = [login];
    api.board.items.push({ id: `P${number}`, issue, sprintId: 'S1', status: 'Backlog', archived: false });
  }
  let sends = 0, reads = 0; const read = deps.projects.readBoard;
  deps.projects.readBoard = async () => { reads++; return read(); };
  deps.send = async (context, message) => { if (++sends === 2) throw new ApiError('telegram', 'retryable', 'offline'); sent.push({ context, message }); return 20; };
  await run(input({ name: 'sprint' })); expect(deps.store.job(1).nextOutput).toBe(1);
  reopen(); now += 5000; await resume();
  expect(sent).toHaveLength(2); expect(reads).toBe(1); expect(deps.store.job(1).phase).toBe('done');
});

test('exhausted send retries retain original outbox and log only job/stage diagnostics', async () => {
  let sends = 0;
  deps.send = async () => { sends++; throw new ApiError('telegram', 'retryable', 'secret fake token'); };
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await run(input()); const original = deps.store.job(1).output;
    now += 5000; await resume(); now += 5000; reopen(); await resume();
    expect(sends).toBe(3); expect(api.createCalls).toHaveLength(1);
    expect(deps.store.job(1)).toMatchObject({ phase: 'done', output: original, nextOutput: 0, attempts: 3 });
    expect(log.mock.calls).toEqual([['GitHubBot job 1: delivery failed after 3 attempt(s)']]);
  } finally { log.mockRestore(); }
});

test('expired and out-of-snapshot choices only answer callback with rejection', async () => {
  await run(input(issueCommand, 1, 14)); const outOfRange = choice(); outOfRange.kind === 'choice' && (outOfRange.repoIndex = 99);
  await run(outOfRange); now += 86_400_000; await run(choice(3));
  expect(answers).toHaveLength(2); expect(answers.every(answer => answer.text.includes('недоступен'))).toBe(true);
  expect(deps.store.job(1).phase).toBe('waiting_repo'); expect(api.createCalls).toHaveLength(0);
});
