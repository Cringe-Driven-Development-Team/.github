import type { BotIdentity, Config } from './config';
import type { Context } from './commands';
import type { Outgoing } from './messages';
import { ApiError, ShutdownError } from './github';

export interface Telegram {
  getMe(): Promise<BotIdentity>;
  getWebhookUrl(): Promise<string>;
  getUpdates(offset: number, signal: AbortSignal): Promise<unknown[]>;
  send(context: Context, message: Outgoing): Promise<number>;
  answerCallback(id: string, text: string): Promise<void>;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function createTelegram(config: Config, fetcher: typeof fetch): Telegram {
  const invalid = (): never => { throw new ApiError('telegram', 'rejected', 'Invalid Telegram response'); };
  async function request(method: string, body: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    let response: Response, value: Record<string, unknown>;
    try {
      response = await fetcher(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(15_000),
        ...(config.telegramProxyUrl === undefined ? {} : { proxy: config.telegramProxyUrl }),
      });
    } catch (error) {
      if (error instanceof ShutdownError) throw error;
      throw new ApiError('telegram', 'retryable', 'Telegram transport failed');
    }
    try { value = object(await response.json()); }
    catch { throw new ApiError('telegram', response.status >= 500 ? 'retryable' : 'rejected', 'Invalid Telegram JSON'); }
    if (!response.ok || value.ok !== true) {
      const code = typeof value.error_code === 'number' ? value.error_code : response.status;
      const retry = object(value.parameters).retry_after;
      throw new ApiError('telegram', code === 429 || response.status >= 500 ? 'retryable' : 'rejected', `Telegram HTTP ${code}`,
        code === 429 && typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 ? retry * 1000 : undefined);
    }
    return value.result;
  }
  return {
    async getMe() {
      const result = object(await request('getMe'));
      if (!positive(result.id) || result.is_bot !== true || typeof result.username !== 'string' || !/^[a-z0-9_]+$/i.test(result.username)) return invalid();
      return { id: String(result.id), username: result.username };
    },
    async getWebhookUrl() {
      const result = object(await request('getWebhookInfo'));
      return typeof result.url === 'string' ? result.url : invalid();
    },
    async getUpdates(offset, signal) {
      const result = await request('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, signal);
      if (!Array.isArray(result) || !result.every(update => {
        const id = object(update).update_id;
        return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 && id < Number.MAX_SAFE_INTEGER;
      })) return invalid();
      return result;
    },
    async send(context, message) {
      const result = object(await request('sendMessage', {
        chat_id: context.chatId, ...(context.threadId === undefined ? {} : { message_thread_id: context.threadId }),
        text: message.html, parse_mode: 'HTML', reply_parameters: { message_id: context.messageId, allow_sending_without_reply: true },
        link_preview_options: { is_disabled: true }, ...(message.keyboard === undefined ? {} : { reply_markup: { inline_keyboard: message.keyboard } }),
      }));
      return positive(result.message_id) ? result.message_id : invalid();
    },
    async answerCallback(id, text) { if (await request('answerCallbackQuery', { callback_query_id: id, text }) !== true) invalid(); },
  };
}
