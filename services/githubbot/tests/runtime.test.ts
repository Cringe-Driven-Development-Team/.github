import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { run, checkHealth } from '../src/main';
import { openStore } from '../src/store';
import { decodeUpdate } from '../src/commands';
import { handleJob } from '../src/handler';
import { apiDoubles, bot, callback, config, message } from './fixtures';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'githubbot-runtime-')); dirs.push(dir);
  return { c: { ...config(), databasePath: join(dir, 'bot.sqlite') }, heartbeat: join(dir, 'health.json'), abort: new AbortController() };
}
const json = (result: unknown) => Response.json({ ok: true, result });
const method = (url: unknown) => String(url).split('/').pop()!;
const waitFor = async (predicate: () => boolean) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await Bun.sleep(5); } throw new Error('Condition timed out'); };
function idle(signal: AbortSignal): Promise<Response> { return new Promise((_resolve, reject) => { if (signal.aborted) reject(new Error('abort')); else signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }); }); }

test.each([
  ['ordinary text', 'private ordinary body'], ['unknown command', '/unknown'], ['other-bot command', '/close@otherbot'], ['media', undefined],
])('intake observes identity from %s before acknowledging without retaining the body', async (_kind, text) => {
  const { c, abort } = setup();
  c.users.push({ telegramId: '102', username: 'bob', githubLogin: 'other' });
  const renamed = message(text ?? '') as any;
  renamed.message.from.username = 'alice_new';
  if (text === undefined) { delete renamed.message.text; renamed.message.photo = [{ file_id: 'private-media' }]; }
  let blockedBeforeAcknowledgement = false;
  const fetcher = (async (url, init) => {
    const m = method(url);
    if (m === 'getMe') return json({ id: 901, username: 'githubbot', is_bot: true });
    if (m === 'getWebhookInfo') return json({ url: '' });
    if (m === 'user') return Response.json({ login: 'octo' });
    if (m === 'getUpdates') {
      if (JSON.parse(String(init!.body)).offset === 0) return json([renamed]);
      const observed = openStore(c.databasePath);
      blockedBeforeAcknowledgement = observed.offset() === 2 && observed.isAliasBlocked('101', 'alice');
      observed.close(); abort.abort(); return json([]);
    }
    throw new Error('Ordinary messages must not trigger API work');
  }) as typeof fetch;
  await run(c, fetcher, abort.signal);
  expect(blockedBeforeAcknowledgement).toBe(true);
  const store = openStore(c.databasePath), api = apiDoubles(), issue = api.seed(), replies: string[] = [];
  try {
    expect(store.offset()).toBe(2); expect(store.nextJob(0)).toBeNull(); expect(() => store.job(1)).toThrow();
    const db = new Database(c.databasePath, { readonly: true });
    try { expect(db.query('SELECT * FROM blocked_aliases').all()).toEqual([{ id: '101', username: 'alice' }]); }
    finally { db.close(); }
    const deps = { config: c, store, github: api.github, projects: api.projects, now: () => new Date(),
      send: async (_context: unknown, outgoing: { html: string }) => { replies.push(outgoing.html); return 20; }, answerCallback: async () => {} };
    for (const [index, name] of ['assign', 'unassign', 'sprint'].entries()) {
      const raw = message(`/${name} @alice${name === 'sprint' ? '' : ' ' + issue.ref.url}`) as any;
      raw.update_id = index + 2; raw.message.from = { id: 102, is_bot: false, username: 'bob' };
      const input = decodeUpdate(raw, c, bot)!; store.ingest([input], input.updateId + 1); await handleJob(store.job(input.updateId), deps);
    }
    expect(api.mutations).toEqual([]); expect(replies).toHaveLength(3); expect(replies.every(reply => reply.includes('устарел'))).toBe(true);
    const self = message('/assignme ' + issue.ref.url) as any; self.update_id = 5; self.message.from.username = 'alice_new';
    store.ingest([decodeUpdate(self, c, bot)!], 6); await handleJob(store.job(5), deps);
    expect(api.mutations).toEqual(['assign:octo']);
    c.users[0]!.username = 'alice_new';
    expect(store.isAliasBlocked('101', 'alice_new')).toBe(false);
  } finally { store.close(); }
});

test.each([
  ['webhook', /webhook.*remove.*explicitly/i],
  ['config', /GITHUBBOT_CONFIG_JSON.*valid/i],
  ['telegram-denied', /Telegram.*credentials.*permissions/i],
  ['github-denied', /GitHub.*credentials.*permissions/i],
  ['github-probe', /GitHub.*startup.*check/i],
  ['transport', /Telegram.*connectivity.*rate limits/i],
  ['unknown', /configuration, startup or runtime failure/],
] as const)('CLI reports sanitized actionable %s failure', async (failure, diagnostic) => {
  const { c, heartbeat } = setup(), preload = join(dirname(c.databasePath), 'failure.ts');
  writeFileSync(heartbeat, JSON.stringify({ lastSuccess: Date.now() }));
  writeFileSync(preload, `globalThis.fetch = async (url) => {
    const failure = ${JSON.stringify(failure)};
    const secret = 'provider-body-secret ' + process.env.TELEGRAM_BOT_TOKEN + ' ' + process.env.GITHUB_TOKEN;
    if (failure === 'transport') throw new Error(secret + ' https://secret.example/transport');
    if (String(url).endsWith('/getMe')) return Response.json(failure === 'telegram-denied'
      ? {ok:false, error_code:401, description:secret} : {ok:true, result:{id:901, username:'githubbot', is_bot:true}});
    if (String(url).endsWith('/getWebhookInfo')) return Response.json({ok:true,result:{url:failure === 'webhook' ? 'https://secret.example/webhook' : ''}});
    if (String(url).endsWith('/user')) return failure === 'unknown' ? new Response(secret)
      : Response.json({message:secret}, {status:failure === 'github-denied' ? 401 : 500});
    throw new Error(secret);
  };`);
  const child = Bun.spawn([process.execPath, '--preload', preload, join(import.meta.dir, '../src/main.ts')], {
    env: { ...process.env, TELEGRAM_BOT_TOKEN: c.telegramToken, GITHUB_TOKEN: c.githubToken, DATABASE_PATH: c.databasePath,
      GITHUBBOT_CONFIG_JSON: failure === 'config' ? 'private-invalid-config' : JSON.stringify(c) }, stdout: 'pipe', stderr: 'pipe',
  });
  expect(await child.exited).toBe(1);
  const output = await new Response(child.stderr).text();
  expect(output).toMatch(diagnostic);
  for (const secret of [c.telegramToken, c.githubToken, 'provider-body-secret', 'https://secret.example', 'private-invalid-config']) expect(output).not.toContain(secret);
  expect(await new Response(child.stdout).text()).toBe('');
  if (failure !== 'config') expect(checkHealth(heartbeat, Date.now())).toBe(false);
});

test('startup validates identity/webhook/GitHub before polling and leaves no health on rejection', async () => {
  for (const failure of ['getMe', 'getWebhookInfo', 'user']) {
    const { c, heartbeat, abort } = setup(), calls: string[] = [];
    writeFileSync(heartbeat, JSON.stringify({ lastSuccess: Date.now() }));
    const fetcher = (async (url, init) => {
      const m = method(url); calls.push(m);
      if (m === failure) return failure === 'getWebhookInfo' ? json({ url: 'https://existing.example/hook' }) : Response.json({ ok: false }, { status: 403 });
      if (m === 'getMe') return json({ id: 901, username: 'actual_bot', is_bot: true });
      if (m === 'getWebhookInfo') return json({ url: '' });
      if (m === 'user') { expect((init as any).proxy).toBeUndefined(); return Response.json({ login: 'octo' }); }
      throw new Error('Polling must not start');
    }) as typeof fetch;
    await expect(run(c, fetcher, abort.signal)).rejects.toBeInstanceOf(Error);
    expect(calls).not.toContain('getUpdates'); expect(calls).not.toContain('deleteWebhook'); expect(checkHealth(heartbeat, Date.now())).toBe(false);
  }
});

test('batch intake durably stores both commands and parser errors before advancing past irrelevant messages', async () => {
  const { c, heartbeat, abort } = setup(), calls: string[] = [], offsets: number[] = [];
  const first = message('/issue@actual_bot First') as any; delete first.message.message_thread_id;
  const bad = { ...(message('/assign') as any), update_id: 2 };
  const second = { ...(message('/issue Second') as any), update_id: 3 }; delete second.message.message_thread_id;
  const irrelevant = { ...(message('hi') as any), update_id: 4 };
  const fetcher = (async (url, init) => {
    const m = method(url); calls.push(m);
    if (m === 'getMe') return json({ id: 901, username: 'actual_bot', is_bot: true });
    if (m === 'getWebhookInfo') return json({ url: '' });
    if (m === 'user') return Response.json({ login: 'octo' });
    if (m === 'sendMessage') return json({ message_id: 20 });
    if (m === 'getUpdates') {
      const offset = JSON.parse(String(init!.body)).offset; offsets.push(offset);
      if (offset === 0) return json([first, bad, second, irrelevant]);
      const db = new Database(c.databasePath); const rows = db.query<any, []>('SELECT * FROM jobs ORDER BY id').all(); db.close();
      expect(rows).toHaveLength(3); expect(JSON.parse(rows[1].input)).toMatchObject({ kind: 'error', actor: { configuredUsername: 'alice' }, updateId: 2 });
      return idle(init!.signal!);
    }
    throw new Error('Unexpected external operation');
  }) as typeof fetch;
  const running = run(c, fetcher, abort.signal);
  await waitFor(() => {
    if (!offsets.includes(5)) return false;
    const store = openStore(c.databasePath); const ready = store.job(1).phase === 'waiting_repo' && store.job(2).phase === 'done' && store.job(3).phase === 'waiting_repo'; store.close(); return ready;
  });
  expect(calls.slice(0, 4)).toEqual(['getMe', 'getWebhookInfo', 'user', 'getUpdates']);
  expect(checkHealth(heartbeat, Date.now())).toBe(true);
  abort.abort(); await running;
  const reopened = openStore(c.databasePath); expect(reopened.offset()).toBe(5); expect(reopened.job(2).nextOutput).toBe(1); reopened.close();
  expect(checkHealth(heartbeat, Date.now())).toBe(false);
});

test('invalid update_id stops the entire batch without durable cursor advance', async () => {
  for (const update_id of [null, '2']) {
    const { c, abort } = setup();
    const fetcher = (async url => method(url) === 'getMe' ? json({ id: 901, username: 'githubbot', is_bot: true })
      : method(url) === 'getWebhookInfo' ? json({ url: '' }) : method(url) === 'user' ? Response.json({ login: 'octo' })
      : json([message('/issue valid'), { update_id }])) as typeof fetch;
    await expect(run(c, fetcher, abort.signal)).rejects.toBeInstanceOf(Error);
    const store = openStore(c.databasePath); expect(store.offset()).toBe(0); expect(store.nextJob(Date.now())).toBeNull(); store.close();
  }
});

test('restart resumes durable error with original alias snapshot and queued commands', async () => {
  const { c, abort } = setup();
  const store = openStore(c.databasePath);
  store.ingest([{ updateId: 8, kind: 'error', context: { chatId: c.chatId, messageId: 10 }, actor: { id: '101', username: 'renamed', configuredUsername: 'alice' }, message: 'Bad command' },
    { ...decodeUpdate(message('/issue queued'), c, bot)!, updateId: 9, context: { chatId: c.chatId, messageId: 11 } }], 10); store.close();
  c.users[0]!.username = 'newalias';
  let sends = 0;
  const fetcher = (async (url, init) => method(url) === 'getMe' ? json({ id: 901, username: 'githubbot', is_bot: true })
    : method(url) === 'getWebhookInfo' ? json({ url: '' }) : method(url) === 'user' ? Response.json({ login: 'octo' })
    : method(url) === 'sendMessage' ? (sends++, json({ message_id: 20 })) : idle(init!.signal!)) as typeof fetch;
  const running = run(c, fetcher, abort.signal); await waitFor(() => sends === 2); abort.abort(); await running;
  const reopened = openStore(c.databasePath); expect(reopened.job(8).phase).toBe('done'); expect(reopened.job(9).phase).toBe('waiting_repo'); expect(reopened.isAliasBlocked('101', 'alice')).toBe(true); expect(reopened.isAliasBlocked('101', 'newalias')).toBe(false); reopened.close();
});

test('callback is acknowledged durably while GitHub worker is busy and shutdown waits for its request', async () => {
  const { c, abort } = setup();
  let polls = 0, githubStarted = false, acknowledged = false, release!: () => void;
  const githubGate = new Promise<void>(resolve => { release = resolve; });
  const fetcher = (async (url, init) => {
    const m = method(url);
    if (m === 'getMe') return json({ id: 901, username: 'githubbot', is_bot: true });
    if (m === 'getWebhookInfo') return json({ url: '' });
    if (m === 'user') return Response.json({ login: 'octo' });
    if (m === 'getUpdates') {
      polls++;
      if (polls === 1) return json([message('/close https://github.com/Cringe-Driven-Development-Team/backend/issues/1')]);
      await waitFor(() => githubStarted);
      if (polls === 2) return json([callback('missing', 0)]);
      return idle(init!.signal!);
    }
    if (m === 'answerCallbackQuery') {
      const s = openStore(c.databasePath); expect(s.offset()).toBe(3); expect(s.job(2).input.kind).toBe('choice'); s.close();
      acknowledged = true; return json(true);
    }
    if (String(url).startsWith('https://api.github.com/')) {
      githubStarted = true; await githubGate;
      return Response.json({ number: 1, node_id: 'I1', title: 'Closed', state: 'closed', assignees: [] });
    }
    if (m === 'sendMessage') return json({ message_id: 21 });
    throw new Error('Unexpected request');
  }) as typeof fetch;
  let stopped = false;
  const running = run(c, fetcher, abort.signal).then(() => { stopped = true; });
  await waitFor(() => acknowledged); abort.abort(); await Bun.sleep(10); expect(stopped).toBe(false);
  release(); await running;
  const store = openStore(c.databasePath); expect(store.job(1).phase).toBe('reply_pending'); expect(store.job(2).phase).toBe('received'); store.close();
});

test('health rejects missing, malformed, stale and future heartbeats', () => {
  const { heartbeat } = setup(), now = Date.now();
  expect(checkHealth(heartbeat, now)).toBe(false);
  for (const value of ['bad', '{}', JSON.stringify({ lastSuccess: now + 1 }), JSON.stringify({ lastSuccess: null })]) { writeFileSync(heartbeat, value); expect(checkHealth(heartbeat, now)).toBe(false); }
  writeFileSync(heartbeat, JSON.stringify({ lastSuccess: now })); expect(checkHealth(heartbeat, now + 120_000)).toBe(true); expect(checkHealth(heartbeat, now + 120_001)).toBe(false);
});

test('worker permission failures stop unhealthy; rate limits remain queued and logs never contain tokens', async () => {
  for (const rateLimited of [false, true]) {
    const { c, heartbeat, abort } = setup(); let issueCalls = 0;
    const capture = spyOn(console, 'error').mockImplementation(() => {});
    const fetcher = (async (url, init) => {
      const m = method(url);
      if (m === 'getMe') return json({ id: 901, username: 'githubbot', is_bot: true });
      if (m === 'getWebhookInfo') return json({ url: '' });
      if (m === 'user') return Response.json({ login: 'octo' });
      if (m === 'getUpdates') return JSON.parse(String(init!.body)).offset === 0
        ? json([message('/close https://github.com/Cringe-Driven-Development-Team/backend/issues/1')]) : idle(init!.signal!);
      if (m === 'sendMessage') { if (rateLimited) abort.abort(); return json({ message_id: 20 }); }
      issueCalls++;
      if (issueCalls === 1) return Response.json({ message: rateLimited ? 'secondary rate limit' : c.githubToken }, { status: 403, ...(rateLimited ? { headers: { 'Retry-After': '0' } } : {}) });
      return Response.json({ number: 1, node_id: 'I1', title: 'Closed', state: 'closed', assignees: [] });
    }) as typeof fetch;
    try {
      if (rateLimited) { await run(c, fetcher, abort.signal); expect(issueCalls).toBe(2); }
      else await expect(run(c, fetcher, abort.signal)).rejects.toBeInstanceOf(Error);
      expect(checkHealth(heartbeat, Date.now())).toBe(false);
      const logs = capture.mock.calls.flat().join(' '); expect(logs).not.toContain(c.githubToken); expect(logs).not.toContain(c.telegramToken);
    } finally { capture.mockRestore(); }
  }
});

test('CLI configuration and health checks are local; fake-fetch process handles SIGTERM with durable SQLite', async () => {
  const { c, heartbeat } = setup(), dir = join(c.databasePath, '..');
  const preload = join(dir, 'fake-fetch.ts');
  writeFileSync(preload, `globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop();
    const ok = result => Response.json({ok:true,result});
    if (method === 'getMe') return ok({id:901,username:'githubbot',is_bot:true});
    if (method === 'getWebhookInfo') return ok({url:''});
    if (method === 'user') return Response.json({login:'octo'});
    if (method === 'sendMessage') return ok({message_id:20});
    if (method === 'getUpdates') {
      if (JSON.parse(init.body).offset === 0) return ok([${JSON.stringify(message('/assign'))}]);
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('cancelled')), {once:true}));
    }
    throw new Error('Unexpected network request');
  };`);
  const main = join(import.meta.dir, '../src/main.ts');
  const env = { ...process.env, TELEGRAM_BOT_TOKEN: c.telegramToken, GITHUB_TOKEN: c.githubToken,
    GITHUBBOT_CONFIG_JSON: JSON.stringify(c), DATABASE_PATH: c.databasePath };
  const check = Bun.spawn([process.execPath, '--preload', preload, main, '--check-config'], { env, stdout: 'pipe', stderr: 'pipe' });
  expect(await check.exited).toBe(0); expect(await new Response(check.stderr).text()).toBe('');
  expect(checkHealth(heartbeat, Date.now())).toBe(false);
  const child = Bun.spawn([process.execPath, '--preload', preload, main], { env, stdout: 'pipe', stderr: 'pipe' });
  try {
    await waitFor(() => {
      if (!checkHealth(heartbeat, Date.now())) return false;
      const db = new Database(c.databasePath, { readonly: true });
      try { return db.query<any, []>('SELECT phase FROM jobs WHERE id = 1').get()?.phase === 'done' && db.query<any, []>('SELECT offset FROM cursor').get()?.offset === 2; }
      finally { db.close(); }
    });
    child.kill('SIGTERM'); expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe('');
    const db = openStore(c.databasePath); expect(db.offset()).toBe(2); expect(db.job(1).phase).toBe('done'); db.close();
    const health = Bun.spawn([process.execPath, main, '--health'], { env: { DATABASE_PATH: c.databasePath }, stdout: 'pipe', stderr: 'pipe' });
    expect(await health.exited).toBe(1);
  } finally { child.kill(); }
});

test('shutdown retains returned create identity and starts no further HTTP stage', async () => {
  const { c, abort } = setup(); let creating = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const calls: string[] = [];
  const fetcher = (async (url, init) => {
    const m = method(url); calls.push(m);
    if (m === 'getMe') return json({ id: 901, username: 'githubbot', is_bot: true });
    if (m === 'getWebhookInfo') return json({ url: '' });
    if (m === 'user') return Response.json({ login: 'octo' });
    if (m === 'getUpdates') return JSON.parse(String(init!.body)).offset === 0 ? json([message('/issue Task')]) : idle(init!.signal!);
    if (m === 'issues') { creating = true; await gate; return Response.json({ number: 5, node_id: 'I5', title: 'Backend. Task', state: 'open', assignees: [] }, { status: 201 }); }
    throw new Error('No stage may start after SIGTERM');
  }) as typeof fetch;
  const running = run(c, fetcher, abort.signal); await waitFor(() => creating); abort.abort(); release(); await running;
  expect(calls).not.toContain('graphql'); expect(calls).not.toContain('sendMessage');
  const store = openStore(c.databasePath); expect(store.job(1)).toMatchObject({ phase: 'issue_created', issue: { nodeId: 'I5' } }); store.close();
});

test('a rejected create stops unhealthy without misclassifying the known rejection as uncertain', async () => {
  const { c, abort } = setup();
  const capture = spyOn(console, 'error').mockImplementation(() => {});
  const fetcher = (async (url, init) => {
    const m = method(url);
    if (m === 'getMe') return json({ id: 901, username: 'githubbot', is_bot: true });
    if (m === 'getWebhookInfo') return json({ url: '' });
    if (m === 'user') return Response.json({ login: 'octo' });
    if (m === 'getUpdates') return JSON.parse(String(init!.body)).offset === 0 ? json([message('/issue Task')]) : idle(init!.signal!);
    if (m === 'issues') return Response.json({ message: 'Permission denied' }, { status: 403 });
    throw new Error('Unexpected request');
  }) as typeof fetch;
  try {
    await expect(run(c, fetcher, abort.signal)).rejects.toBeInstanceOf(Error);
    const store = openStore(c.databasePath); expect(store.job(1).phase).toBe('reply_pending'); store.close();
  } finally { capture.mockRestore(); }
});
