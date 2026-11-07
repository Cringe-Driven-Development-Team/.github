import { expect, test } from 'bun:test';
import { createTelegram } from '../src/telegram';
import { ApiError } from '../src/github';
import { config } from './fixtures';

test('Telegram transport keeps proxy, topic, poll restrictions and callbacks on the Telegram host', async () => {
  const calls: { url: string; init: RequestInit & { proxy?: unknown }; body: any }[] = [];
  const c = { ...config(), telegramProxyUrl: 'http://proxy:8080' };
  const fetcher = (async (url, init) => {
    const method = String(url).split('/').pop();
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true, result: method === 'getMe' ? { id: 901, username: 'actual_bot', is_bot: true }
      : method === 'getWebhookInfo' ? { url: '' } : method === 'getUpdates' ? [{ update_id: 7 }] : method === 'sendMessage' ? { message_id: 20 } : true });
  }) as typeof fetch;
  const telegram = createTelegram(c, fetcher);
  expect(await telegram.getMe()).toEqual({ id: '901', username: 'actual_bot' });
  expect(await telegram.getWebhookUrl()).toBe('');
  expect(await telegram.getUpdates(7, new AbortController().signal)).toEqual([{ update_id: 7 }]);
  expect(await telegram.send({ chatId: c.chatId, threadId: 11, messageId: 10 }, { html: '<b>Hi</b>', keyboard: [[{ text: 'repo', callback_data: 'repo:a:0' }]] })).toBe(20);
  await telegram.answerCallback('cb', 'Принято');
  expect(calls.every(call => new URL(call.url).hostname === 'api.telegram.org' && call.init.proxy === c.telegramProxyUrl && call.init.redirect === 'manual')).toBe(true);
  expect(calls[2]!.body).toEqual({ offset: 7, timeout: 25, allowed_updates: ['message', 'callback_query'] });
  expect(calls[3]!.body).toEqual({ chat_id: c.chatId, message_thread_id: 11, text: '<b>Hi</b>', parse_mode: 'HTML',
    reply_parameters: { message_id: 10, allow_sending_without_reply: true }, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: 'repo', callback_data: 'repo:a:0' }]] } });
  expect(calls[4]!.body).toEqual({ callback_query_id: 'cb', text: 'Принято' });
});

test('HTTP 200 errors and 429 retry_after become sanitized ApiErrors', async () => {
  for (const [status, body, kind, delay] of [[200, { ok: false, error_code: 403, description: config().telegramToken }, 'rejected', undefined],
    [429, { ok: false, error_code: 429, parameters: { retry_after: 9 } }, 'retryable', 9000]] as const) {
    const telegram = createTelegram(config(), (async () => Response.json(body, { status })) as unknown as typeof fetch);
    try { await telegram.getMe(); throw new Error('Expected rejection'); }
    catch (error) { expect(error).toBeInstanceOf(ApiError); expect(error).toMatchObject({ provider: 'telegram', kind, retryAfterMs: delay }); expect(String(error)).not.toContain(config().telegramToken); }
  }
});

test('malformed batch identifiers and malformed success responses are rejected', async () => {
  for (const result of [[{ update_id: 1 }, { update_id: null }], [{ update_id: '2' }], [{ update_id: -1 }], [{ update_id: Number.MAX_SAFE_INTEGER }], null]) {
    const telegram = createTelegram(config(), (async () => Response.json({ ok: true, result })) as unknown as typeof fetch);
    await expect(telegram.getUpdates(0, new AbortController().signal)).rejects.toBeInstanceOf(ApiError);
  }
  for (const result of [{ id: 1 }, { id: 1, username: 'bot', is_bot: false }]) {
    await expect(createTelegram(config(), (async () => Response.json({ ok: true, result })) as unknown as typeof fetch).getMe()).rejects.toBeInstanceOf(ApiError);
  }
});

test('poll cancellation reaches fetch without leaking the transport error', async () => {
  const abort = new AbortController();
  const telegram = createTelegram(config(), (async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error(config().telegramToken)), { once: true });
    abort.abort();
  })) as typeof fetch);
  await expect(telegram.getUpdates(0, abort.signal)).rejects.toMatchObject({ provider: 'telegram', kind: 'retryable' });
});
