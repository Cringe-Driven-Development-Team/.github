import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context, Input } from '../src/commands';
import type { Issue } from '../src/github';
import { openStore, type Store } from '../src/store';

const day = 24 * 60 * 60 * 1000;
const context: Context = { chatId: '-1001', threadId: 14, messageId: 10 };
const input = (updateId = 1): Input => ({ updateId, context, actor: { id: '101', username: 'alice' },
  kind: 'command', command: { name: 'issue', title: 'Task', body: 'Details' } });
const issue: Issue = { ref: { repo: 'backend', number: 3, url: 'https://github.com/Cringe-Driven-Development-Team/backend/issues/3' },
  nodeId: 'I_3', title: 'Backend. Task', state: 'OPEN', assignees: [] };

let directory: string;
let path: string;
let store: Store;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'githubbot-store-'));
  path = join(directory, 'journal.sqlite');
  store = openStore(path);
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
const reopen = () => { store.close(); store = openStore(path); };
const choice = (jobId = 1) => {
  store.ingest([input(jobId)], jobId + 1);
  const id = store.createChoice(jobId, ['frontend', 'backend'], day);
  store.bindPrompt(id, 20);
  store.checkpoint(jobId, { phase: 'waiting_repo' });
  return id;
};

describe('durable intake and journal', () => {
  test('deduplicates update IDs and keeps input and cursor across file reopen', () => {
    expect(store.offset()).toBe(0);
    store.ingest([input()], 2);
    store.ingest([input()], 2);
    reopen();
    expect(store.offset()).toBe(2);
    expect(store.nextJob(0)).toEqual({ id: 1, input: input(), phase: 'received', nextOutput: 0, nextAttemptAt: 0, attempts: 0 });
    store.checkpoint(1, { phase: 'done' });
    expect(store.nextJob(0)).toBeNull();
  });

  test('rolls back the whole intake batch and cursor when serialization fails', () => {
    store.ingest([input()], 2);
    const bad = input(3);
    (bad as unknown as { command: unknown }).command = bad;
    expect(() => store.ingest([input(2), bad], 4)).toThrow();
    reopen();
    expect(store.offset()).toBe(2);
    expect(() => store.job(2)).toThrow();
    expect(() => store.job(3)).toThrow();
  });

  test('skips waiting, finished and future jobs without blocking later inputs', () => {
    store.ingest([input(1), input(2), input(3), input(4)], 5);
    store.checkpoint(1, { phase: 'waiting_repo' });
    store.checkpoint(2, { phase: 'done' });
    store.checkpoint(3, { phase: 'ready', nextAttemptAt: 100 });
    expect(store.nextJob(0)?.id).toBe(4);
    store.checkpoint(4, { phase: 'done' });
    expect(store.nextJob(99)).toBeNull();
    expect(store.nextJob(100)?.id).toBe(3);
  });

  test('persists known issue, outbox progress and retries instead of replaying completed operations', () => {
    store.ingest([input()], 2);
    store.checkpoint(1, { phase: 'reply_pending', issue, output: [{ html: 'first' }, { html: 'second' }], nextOutput: 1,
      nextAttemptAt: 50, attempts: 3, selectedRepo: 'backend' });
    reopen();
    expect(store.job(1)).toMatchObject({ phase: 'reply_pending', issue, output: [{ html: 'first' }, { html: 'second' }],
      nextOutput: 1, nextAttemptAt: 50, attempts: 3, selectedRepo: 'backend' });
  });

  test('recovery makes unconfirmed creation terminal and delivers only the unsent warning', () => {
    store.ingest([input()], 2);
    store.checkpoint(1, { phase: 'creating' });
    reopen(); store.recover();
    const recovered = store.job(1);
    expect(recovered.phase).toBe('uncertain');
    expect(recovered.output?.length).toBeGreaterThan(0);
    expect(recovered.output?.[0]?.html).toMatch(/GitHub/);
    expect(store.nextJob(0)?.id).toBe(1);
    expect(() => store.checkpoint(1, { phase: 'ready' })).toThrow();
    expect(() => store.checkpoint(1, { phase: 'creating' })).toThrow();
    store.checkpoint(1, { nextOutput: recovered.output!.length });
    reopen(); store.recover();
    expect(store.job(1).phase).toBe('uncertain');
    expect(store.nextJob(0)).toBeNull();
  });

  test('uncertain jobs without warning output are never runnable', () => {
    store.ingest([input()], 2);
    store.checkpoint(1, { phase: 'uncertain' });
    store.recover();
    expect(store.nextJob(0)).toBeNull();
  });

  test('recovery reads before a repeated mutation and resumes a creation with saved identity', () => {
    store.ingest([input(1), input(2)], 3);
    store.checkpoint(1, { phase: 'mutating', issue });
    store.checkpoint(2, { phase: 'creating', issue });
    reopen(); store.recover();
    expect(store.job(1)).toMatchObject({ phase: 'ready', issue });
    expect(store.job(2)).toMatchObject({ phase: 'issue_created', issue });
  });
});

describe('repository choices', () => {
  test('prepare is restart-safe without stranding a job before prompt delivery', () => {
    store.ingest([input()], 2);
    const id = store.createChoice(1, ['frontend', 'backend'], day);
    expect(store.job(1)).toMatchObject({ phase: 'received', choiceId: id });
    reopen();
    expect(store.createChoice(1, ['backend', 'frontend'], 2 * day)).toBe(id);
    expect(store.choiceRepositories(id)).toEqual(['frontend', 'backend']);
    expect(() => store.choiceRepositories('unknown')).toThrow();
    expect(() => store.choose(id, '101', context, 20, 0, 1)).toThrow();
    expect(store.job(1).phase).toBe('received');
    store.bindPrompt(id, 20);
    store.checkpoint(1, { phase: 'waiting_repo' });
    expect(store.choose(id, '101', { ...context, messageId: 20 }, 20, 0, 1)).toBe(1);
    expect(store.job(1)).toMatchObject({ phase: 'ready', selectedRepo: 'frontend' });
  });

  test.each([
    ['expired', '101', context, 20, 0, day],
    ['wrong actor', '102', context, 20, 0, 0],
    ['wrong chat', '101', { ...context, chatId: '-1002' }, 20, 0, 0],
    ['wrong topic', '101', { ...context, threadId: 15 }, 20, 0, 0],
    ['missing topic', '101', { chatId: '-1001', messageId: 20 }, 20, 0, 0],
    ['wrong prompt', '101', context, 21, 0, 0],
    ['negative index', '101', context, 20, -1, 0],
    ['out of range', '101', context, 20, 2, 0],
    ['fractional index', '101', context, 20, 0.5, 0],
  ] as const)('rejects %s without changing the original job', (_name, actor, ctx, prompt, index, now) => {
    const id = choice();
    expect(() => store.choose(id, actor, ctx, prompt, index, now)).toThrow();
    expect(store.job(1)).toMatchObject({ phase: 'waiting_repo' });
    expect(store.job(1).selectedRepo).toBeUndefined();
  });

  test('a prompt cannot be rebound to a different message', () => {
    const id = choice();
    store.bindPrompt(id, 20);
    expect(() => store.bindPrompt(id, 21)).toThrow();
    expect(() => store.choose('unknown', '101', context, 20, 0, 0)).toThrow();
  });

  test('same author requests remain independent and repeated callbacks cannot reset a completed job', () => {
    const first = choice(1), second = choice(2);
    expect(first).not.toBe(second);
    expect(store.choose(first, '101', context, 20, 1, 0)).toBe(1);
    store.checkpoint(1, { phase: 'done', issue, nextOutput: 1, output: [{ html: 'Created' }] });
    reopen();
    expect(store.choose(first, '101', context, 20, 0, 0)).toBe(1);
    expect(store.job(1)).toMatchObject({ phase: 'done', selectedRepo: 'backend', issue, nextOutput: 1 });
    expect(store.job(2).phase).toBe('waiting_repo');
    expect(store.choose(second, '101', context, 20, 0, 0)).toBe(2);
    expect(store.job(2)).toMatchObject({ phase: 'ready', selectedRepo: 'frontend' });
  });
});

test('blocked aliases survive reopen but an updated configured username is independent', () => {
  store.blockAlias('101', 'alice');
  reopen();
  expect(store.isAliasBlocked('101', 'alice')).toBe(true);
  expect(store.isAliasBlocked('101', 'alice_new')).toBe(false);
  expect(store.isAliasBlocked('102', 'alice')).toBe(false);
});
