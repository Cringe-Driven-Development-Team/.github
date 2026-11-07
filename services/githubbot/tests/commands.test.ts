import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config';
import { CommandError, decodeUpdate, normalizeTitle, parseIssueUrl, type Actor } from '../src/commands';
import { bot, callback, config, message } from './fixtures';

const url = 'https://github.com/Cringe-Driven-Development-Team/backend/issues/7';
const target = { repo: 'backend', number: 7, url };
function card(sender = 900) {
  const text = '🔔 backend#7 Заголовок\nЧужая frontend#8';
  return {
    message_id: 9, date: 1, chat: { id: -1001, type: 'supergroup' }, message_thread_id: 11,
    from: { id: sender, is_bot: true, first_name: 'Monitoring' }, text,
    entities: [
      { type: 'text_link', offset: text.indexOf('backend#7'), length: 'backend#7'.length, url },
      { type: 'blockquote', offset: text.indexOf('Чужая'), length: 'Чужая frontend#8'.length },
      { type: 'text_link', offset: text.indexOf('frontend#8'), length: 'frontend#8'.length, url: 'https://github.com/Cringe-Driven-Development-Team/frontend/issues/8' },
    ],
    reply_markup: { inline_keyboard: [[{ text: 'Открыть задачу', url }]] },
  };
}
function env(c = config()) {
  return { TELEGRAM_BOT_TOKEN: 'secret-telegram', GITHUB_TOKEN: 'secret-github', GITHUBBOT_CONFIG_JSON: JSON.stringify(c) };
}

test('repo prefixes and raw description', () => {
  const c = config(), r = c.repositories.find(x => x.name === 'frontend')!;
  expect(normalizeTitle('Форма', r, c.repositories)).toBe('Frontend. Форма');
  expect(normalizeTitle('BFF. Сессия', r, c.repositories)).toBe('BFF. Сессия');
  expect(() => normalizeTitle('Backend. Сессия', r, c.repositories)).toThrow();
  expect(() => normalizeTitle('  ', r, c.repositories)).toThrow();
  expect(decodeUpdate(message('/issue Форма\n**Описание**\n  text\n'), c, bot))
    .toMatchObject({ command: { name: 'issue', title: 'Форма', body: '**Описание**\n  text\n' } });
});

describe.each(['close', 'assign', 'assignme', 'unassign', 'tosprint'])('%s target', name => {
  const args = ['assign', 'unassign'].includes(name) ? ' @ALICE' : '';
  test('reply and explicit URL resolve to the same issue', () => {
    for (const raw of [message(`/${name}${args}`, card()), message(`/${name}${args} ${url}`)]) {
      expect(decodeUpdate(raw, config(), bot)).toMatchObject({ kind: 'command', command: { name, target } });
    }
  });
  test.each(['none', 'both', 'short'])('rejects %s target with contextual CommandError', variant => {
    const raw = variant === 'both' ? message(`/${name}${args} ${url}`, card()) : message(`/${name}${args}${variant === 'short' ? ' #7' : ''}`);
    try { decodeUpdate(raw, config(), bot); throw new Error('expected CommandError'); }
    catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      expect(error).toMatchObject({ updateId: 1, context: { chatId: '-1001', threadId: 11, messageId: 10 }, actor: { id: '101', username: 'alice' } });
    }
  });
});

test('sprint accepts no target or configured username, case insensitive', () => {
  expect(decodeUpdate(message('/sprint'), config(), bot)).toMatchObject({ command: { name: 'sprint' } });
  expect(decodeUpdate(message('/sprint @ALICE'), config(), bot)).toMatchObject({ command: { name: 'sprint', username: 'alice' } });
  expect(() => decodeUpdate(message('/sprint @unknown'), config(), bot)).toThrow(CommandError);
  expect(() => decodeUpdate(message('/assign alice ' + url), config(), bot)).toThrow(CommandError);
  expect(() => decodeUpdate(message('/issue\nbody'), config(), bot)).toThrow(CommandError);
});

test('decoder captures configured alias separately from observed username for commands and errors', () => {
  const raw = message('/sprint') as { message: { from: { username: string } } };
  raw.message.from.username = 'alice_new';
  expect(decodeUpdate(raw, config(), bot)?.actor).toEqual({ id: '101', username: 'alice_new', configuredUsername: 'alice' });
  try { decodeUpdate(message('/issue'), config(), bot); throw new Error('expected CommandError'); }
  catch (error) {
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).actor).toEqual({ id: '101', username: 'alice', configuredUsername: 'alice' });
  }
});

test.each([
  'https://name:password@github.com/Cringe-Driven-Development-Team/backend/issues/7',
  'https://github.com.evil.test/Cringe-Driven-Development-Team/backend/issues/7',
  'https://github.com/other/backend/issues/7',
  'https://github.com/Cringe-Driven-Development-Team/private/issues/7',
  'https://github.com/Cringe-Driven-Development-Team/backend/pull/1',
  'http://github.com/Cringe-Driven-Development-Team/backend/issues/7',
  'https://github.com:8443/Cringe-Driven-Development-Team/backend/issues/7',
  url + '?evil=1', url + '#other', url.replace('/7', '/0'), url.replace('/7', '/9007199254740992'),
])('rejects unsafe/non-issue URL %s', value => expect(() => parseIssueUrl(value, config())).toThrow());

test('canonical issue and comment URLs normalize to one target', () => {
  expect(parseIssueUrl(url, config())).toEqual(target);
  expect(parseIssueUrl(url + '#issuecomment-123', config())).toEqual(target);
});

test('trusted header wins over quoted links with UTF-16 offsets', () => {
  expect(decodeUpdate(message('/close', card()), config(), bot)).toMatchObject({ command: { target } });
  expect(decodeUpdate(message('/close', card(901)), config(), bot)).toMatchObject({ command: { target } });
  const own = card(901);
  own.entities[0]!.length = 2;
  own.text = own.text.replace('backend#7', '#7');
  own.entities = own.entities.slice(0, 1);
  expect(decodeUpdate(message('/close', own), config(), bot)).toMatchObject({ command: { target } });
});

test('different canonical header/button issues are ambiguous; matching comment is deduplicated', () => {
  const reply = card();
  reply.reply_markup.inline_keyboard[0]![0]!.url = url.replace('/7', '/8');
  expect(() => decodeUpdate(message('/close', reply), config(), bot)).toThrow(CommandError);
  reply.reply_markup.inline_keyboard[0]![0]!.url = url + '#issuecomment-123';
  expect(decodeUpdate(message('/close', reply), config(), bot)).toMatchObject({ command: { target } });
});

test('monitoring header links include title text and still detect conflicting buttons', () => {
  const reply = card();
  reply.text = '🆕 Новая задача · backend\n#7 Заголовок\nавтор: Alice';
  reply.entities = [{ type: 'text_link', offset: reply.text.indexOf('#7'), length: '#7 Заголовок'.length, url }];
  reply.reply_markup.inline_keyboard[0]![0]!.url = url.replace('/7', '/8');
  expect(() => decodeUpdate(message('/close', reply), config(), bot)).toThrow(CommandError);
  reply.reply_markup.inline_keyboard = [];
  expect(decodeUpdate(message('/close', reply), config(), bot)).toMatchObject({ command: { target } });
});

test('rejects forged, forwarded, unavailable and cross-topic/card replies', () => {
  const forwarded = { ...card(), forward_origin: { type: 'user', date: 1 } };
  for (const reply of [card(999), forwarded, { message_id: 9 }, { ...card(), message_thread_id: 12 }, { ...card(), chat: { id: -1002, type: 'supergroup' } }]) {
    expect(() => decodeUpdate(message('/close', reply), config(), bot)).toThrow(CommandError);
  }
});

test('ignores unknown commands, other bots, edited messages and unauthorized senders', () => {
  expect(decodeUpdate(message('/unknown'), config(), bot)).toBeNull();
  expect(decodeUpdate(message('/close@otherbot'), config(), bot)).toBeNull();
  expect(decodeUpdate(message('/sprint@GITHUBBOT'), config(), bot)).toMatchObject({ command: { name: 'sprint' } });
  const raw = message('/sprint') as any;
  expect(decodeUpdate({ update_id: 1, edited_message: raw.message }, config(), bot)).toBeNull();
  for (const fields of [{ from: { id: 999, is_bot: false } }, { from: { id: 101, is_bot: true } }, { sender_chat: { id: -1001 } }, { chat: { id: -1002 } }]) {
    expect(decodeUpdate({ ...raw, message: { ...raw.message, ...fields } }, config(), bot)).toBeNull();
  }
  for (const raw of [null, [], {}, { update_id: 'bad', message: {} }]) expect(decodeUpdate(raw, config(), bot)).toBeNull();
});

test('identity observation keeps the same authentication scope as commands', () => {
  const observed: Actor[] = [], capture = (actor: Actor) => { observed.push(actor); };
  const raw = message('private ordinary message') as any;
  raw.message.from.username = 'alice_new';
  for (const fields of [{ from: { id: 999, is_bot: false, username: 'alice_new' } }, { from: { id: 101, is_bot: true } },
    { sender_chat: { id: -1001 } }, { chat: { id: -1002 } }, { message_thread_id: -1 }]) {
    expect(decodeUpdate({ ...raw, message: { ...raw.message, ...fields } }, config(), bot, capture)).toBeNull();
  }
  expect(decodeUpdate({ update_id: 1, edited_message: raw.message }, config(), bot, capture)).toBeNull();
  const foreignCallback = callback('request', 0) as any; foreignCallback.callback_query.message.from.id = 900;
  expect(decodeUpdate(foreignCallback, config(), bot, capture)).toBeNull();
  expect(observed).toEqual([]);
  expect(decodeUpdate(raw, config(), bot, capture)).toBeNull();
  expect(observed).toEqual([{ id: '101', username: 'alice_new', configuredUsername: 'alice' }]);
  raw.message.text = '/issue';
  expect(() => decodeUpdate(raw, config(), bot, capture)).toThrow(CommandError);
  expect(observed).toHaveLength(2);
});

test('choice carries opaque request, repository index and original prompt identity', () => {
  expect(decodeUpdate(callback('request-123', 1), config(), bot)).toEqual({
    kind: 'choice', updateId: 2, context: { chatId: '-1001', threadId: 14, messageId: 20 },
    actor: { id: '101', username: 'alice', configuredUsername: 'alice' }, requestId: 'request-123', repoIndex: 1,
    callbackId: 'callback-1', promptMessageId: 20,
  });
  expect(decodeUpdate(callback('request-123', 1, '999'), config(), bot)).toBeNull();
  expect(decodeUpdate(callback('request-123', 99), config(), bot)).toMatchObject({ kind: 'choice', repoIndex: 99 });
  expect(() => decodeUpdate(callback('request-123', Number.MAX_SAFE_INTEGER + 1), config(), bot)).toThrow(CommandError);
  const raw = callback('request-123', 1) as any;
  raw.callback_query.data = 'repo:bad payload:1';
  expect(() => decodeUpdate(raw, config(), bot)).toThrow(CommandError);
  raw.callback_query.message.from.id = 900;
  expect(decodeUpdate(raw, config(), bot)).toBeNull();
});

test('loads config with string IDs, normalized aliases and default database path', () => {
  const c = config(); c.users[0]!.username = '@Alice';
  expect(loadConfig(env(c))).toMatchObject({ chatId: '-1001', databasePath: '/data/githubbot.sqlite', users: [{ telegramId: '101', username: 'alice', githubLogin: 'octo' }] });
  expect(loadConfig({ ...env(), DATABASE_PATH: '/tmp/test.sqlite', TELEGRAM_PROXY_URL: 'http://localhost:3128' })).toMatchObject({ databasePath: '/tmp/test.sqlite', telegramProxyUrl: 'http://localhost:3128' });
});

test('shared area prefixes load and normalize in each selected repository', () => {
  const c = config();
  c.repositories.push(
    { name: 'infra', defaultPrefix: 'DevOps.', prefixes: ['DevOps.'] },
    { name: '.github', defaultPrefix: 'DevOps.', prefixes: ['DevOps.'] },
  );
  const loaded = loadConfig(env(c));
  for (const name of ['infra', '.github']) {
    const repo = loaded.repositories.find(r => r.name === name)!;
    expect(normalizeTitle('Настроить бота', repo, loaded.repositories)).toBe('DevOps. Настроить бота');
    expect(normalizeTitle('DevOps. Настроить бота', repo, loaded.repositories)).toBe('DevOps. Настроить бота');
  }
});

test.each(['telegramId', 'username', 'githubLogin'])('rejects duplicate user %s', field => {
  const c = config(); c.users.push({ telegramId: '102', username: 'bob', githubLogin: 'other', [field]: c.users[0]![field as keyof typeof c.users[number]] });
  expect(() => loadConfig(env(c))).toThrow();
});

test('rejects duplicate repos, topics, invalid IDs and broken prefix routing', () => {
  for (const mutate of [
    (c: ReturnType<typeof config>) => c.repositories.push({ ...c.repositories[0]! }),
    (c: ReturnType<typeof config>) => c.topics.push({ ...c.topics[0]! }),
    (c: ReturnType<typeof config>) => { c.chatId = 'group'; },
    (c: ReturnType<typeof config>) => { c.users[0]!.telegramId = 'alice'; },
    (c: ReturnType<typeof config>) => { c.notificationBotIds = ['bot']; },
    (c: ReturnType<typeof config>) => { c.topics[0]!.threadId = 1.5; },
    (c: ReturnType<typeof config>) => { c.topics[0]!.repository = 'unknown'; },
    (c: ReturnType<typeof config>) => { c.repositories[0]!.defaultPrefix = 'Other.'; },
  ]) {
    const c = config(); mutate(c); expect(() => loadConfig(env(c))).toThrow();
  }
});

test('invalid credentials and malformed config errors do not echo secret values', () => {
  for (const values of [{ ...env(), TELEGRAM_BOT_TOKEN: '' }, { ...env(), GITHUB_TOKEN: ' ' }, { ...env(), GITHUBBOT_CONFIG_JSON: 'secret-invalid-json' }, { ...env(), TELEGRAM_PROXY_URL: 'socks://secret-host' }]) {
    expect(() => loadConfig(values)).toThrow();
    try { loadConfig(values); } catch (error) { expect(String(error)).not.toMatch(/secret-/); }
  }
});
