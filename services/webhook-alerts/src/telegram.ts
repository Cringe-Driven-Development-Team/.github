import type { OutgoingMessage } from './store';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  proxyUrl?: string;
}

// Only these safe fields may reach the database or logs. Never return Telegram bodies.
export type SendResult =
  | { kind: 'sent'; telegramMessageId: number }
  | { kind: 'retry'; errorCode: string; httpStatus?: number; retryAfterMs?: number; ambiguous?: boolean }
  | { kind: 'failed'; errorCode: string; httpStatus?: number }
  | { kind: 'entities'; errorCode: 'telegram_entities'; httpStatus: 400 };

export async function sendMessage(message: OutgoingMessage, config: TelegramConfig, fetcher: typeof fetch): Promise<SendResult> {
  let response: Response;
  let body: Record<string, unknown> = {};
  try {
    response = await fetcher(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5000), redirect: 'error',
      ...(config.proxyUrl === undefined ? {} : { proxy: { url: config.proxyUrl, respectNoProxy: false } }),
      body: JSON.stringify({
        chat_id: config.chatId, message_thread_id: message.topic, text: message.html,
        parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        ...(message.keyboard ? { reply_markup: {inline_keyboard:message.keyboard} } : message.button ? { reply_markup: { inline_keyboard: [[message.button, ...(message.secondaryButton ? [message.secondaryButton] : [])]] } } : {}),
      }),
    });
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      // HTTP errors remain classifiable even when an upstream proxy returns non-JSON.
    }
  } catch {
    // Error.message can contain the token-bearing URL.
    return { kind: 'retry', errorCode: 'network', ambiguous:true };
  }

  const httpStatus = response.status;
  const errorCode = `telegram_${httpStatus}`;
  if (httpStatus === 429) {
    const parameters = body.parameters as { retry_after?: unknown } | undefined;
    const seconds = parameters?.retry_after;
    const retryAfterMs = typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0
      && Number.isSafeInteger(seconds * 1000 + 1000) ? seconds * 1000 + 1000 : undefined;
    return { kind: 'retry', errorCode, httpStatus, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  if (httpStatus >= 500) return { kind: 'retry', errorCode, httpStatus, ambiguous:true };
  if (httpStatus === 400 && typeof body.description === 'string' && /can'?t parse entities|can't find end of the entity/i.test(body.description)) {
    return { kind: 'entities', errorCode: 'telegram_entities', httpStatus: 400 };
  }
  if (httpStatus >= 400 && httpStatus < 500) return { kind: 'failed', errorCode, httpStatus };
  const result = body.result as { message_id?: unknown } | undefined;
  const id = result?.message_id;
  if (response.ok && body.ok === true && typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
    return { kind: 'sent', telegramMessageId: id };
  }
  return { kind: 'retry', errorCode: 'telegram_invalid_response', httpStatus, ambiguous:true };
}
