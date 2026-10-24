import type { TelegramConfig } from './telegram';

export interface Config {
  githubWebhookSecret: string;
  apidogSignatureKey: string;
  apidogSignatureHeader: string;
  databasePath: string;
  port: number;
  sendEnabled: boolean;
  telegram?: TelegramConfig;
  githubApiToken?: string;
  githubTopic: number;
  reviewTopic: number;
  apidogTopic?: number;
  userMap: Record<string, string | number>;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const required = (name: string): string => {
    const value = env[name];
    if (!value?.trim()) throw new Error(`${name} is required`);
    return value;
  };
  const githubWebhookSecret = required('GITHUB_WEBHOOK_SECRET');
  const apidogSignatureKey = required('APIDOG_SIGNATURE_KEY');
  const apidogSignatureHeader = required('APIDOG_SIGNATURE_HEADER');
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(apidogSignatureHeader)) throw new Error('APIDOG_SIGNATURE_HEADER must be an HTTP header name');

  const portText = env.PORT ?? '8080';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  const databasePath = env.DATABASE_PATH ?? '/data/queue.sqlite';
  if (!databasePath.trim()) throw new Error('DATABASE_PATH must not be empty');
  const flag = env.WEBHOOK_ALERTS_SEND_ENABLED ?? 'false';
  if (flag !== 'true' && flag !== 'false') throw new Error('WEBHOOK_ALERTS_SEND_ENABLED must be true or false');
  const sendEnabled = flag === 'true';
  const topic = (name: string, fallback?: number): number | undefined => {
    if (env[name] === undefined) return fallback;
    const value = Number(env[name]);
    if (!/^[1-9]\d*$/.test(env[name]!) || !Number.isSafeInteger(value)) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const githubTopic = topic('TELEGRAM_TOPIC_ID', 26)!;
  const reviewTopic = topic('TELEGRAM_REVIEW_TOPIC_ID', 1513)!;
  const apidogTopic = topic('TELEGRAM_APIDOG_TOPIC_ID');
  let telegram: TelegramConfig | undefined;
  if (sendEnabled) telegram = { botToken: required('TELEGRAM_BOT_TOKEN'), chatId: required('TELEGRAM_CHAT_ID') };
  if (env.TELEGRAM_CHAT_ID !== undefined && !/^-?[1-9]\d*$/.test(env.TELEGRAM_CHAT_ID)) throw new Error('TELEGRAM_CHAT_ID must be an integer ID');
  if (sendEnabled && apidogTopic === undefined) throw new Error('TELEGRAM_APIDOG_TOPIC_ID is required');
  let userMap: Record<string, string | number> = {};
  if (env.TELEGRAM_USER_MAP !== undefined) {
    try {
      const value: unknown = JSON.parse(env.TELEGRAM_USER_MAP);
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.values(value).every(id =>
        (typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id)) || (typeof id === 'number' && Number.isSafeInteger(id) && id > 0))) throw new Error();
      userMap = value as typeof userMap;
    } catch { throw new Error('TELEGRAM_USER_MAP must map GitHub logins to Telegram user IDs'); }
  }
  return { githubWebhookSecret, apidogSignatureKey, apidogSignatureHeader, databasePath, port, sendEnabled,
    telegram, githubApiToken: env.GITHUB_API_TOKEN, githubTopic, reviewTopic, apidogTopic, userMap };
}
