import type { ApidogMergeConfig } from './apidog-merge';
import { safeUrl } from './format';
import type { TelegramConfig } from './telegram';

export interface Config {
  apidogMerge?: ApidogMergeConfig;
  apidogAccessToken?: string;
  githubWebhookSecret: string;
  apidogSignatureKey: string;
  apidogSignatureHeader: string;
  databasePath: string;
  port: number;
  sendEnabled: boolean;
  telegram?: TelegramConfig;
  apidogTelegram?: TelegramConfig;
  githubApiToken?: string;
  githubTopic: number;
  releasesTopic?: number;
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
  const releasesTopic = topic('TELEGRAM_RELEASES_TOPIC_ID');
  const reviewTopic = topic('TELEGRAM_REVIEW_TOPIC_ID', 1513)!;
  const apidogTopic = topic('TELEGRAM_APIDOG_TOPIC_ID');
  const proxyUrl = env.TELEGRAM_PROXY_URL;
  if (proxyUrl !== undefined) {
    try {
      const url = new URL(proxyUrl);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error();
    } catch { throw new Error('TELEGRAM_PROXY_URL must be an HTTP or HTTPS URL with a hostname'); }
  }
  let telegram: TelegramConfig | undefined;
  if (sendEnabled) telegram = { botToken: required('TELEGRAM_BOT_TOKEN'), chatId: required('TELEGRAM_CHAT_ID'), ...(proxyUrl === undefined ? {} : { proxyUrl }) };
  if (env.TELEGRAM_CHAT_ID !== undefined && !/^-?[1-9]\d*$/.test(env.TELEGRAM_CHAT_ID)) throw new Error('TELEGRAM_CHAT_ID must be an integer ID');
  if (sendEnabled && apidogTopic === undefined) throw new Error('TELEGRAM_APIDOG_TOPIC_ID is required');
  const apidogTelegram = sendEnabled ? { ...telegram!, botToken: required('TELEGRAM_APIDOG_BOT_TOKEN') } : undefined;
  let userMap: Record<string, string | number> = {};
  if (env.TELEGRAM_USER_MAP !== undefined) {
    try {
      const value: unknown = JSON.parse(env.TELEGRAM_USER_MAP);
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.values(value).every(id =>
        (typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id)) || (typeof id === 'number' && Number.isSafeInteger(id) && id > 0))) throw new Error();
      userMap = value as typeof userMap;
    } catch { throw new Error('TELEGRAM_USER_MAP must map GitHub logins to Telegram user IDs'); }
  }
  let apidogMerge: ApidogMergeConfig | undefined;
  let apidogAccessToken: string | undefined;
  if (sendEnabled) {
    apidogAccessToken = required('APIDOG_ACCESS_TOKEN');
    const projectId = topic('APIDOG_PROJECT_ID');
    const targetBranchId = topic('APIDOG_TARGET_BRANCH_ID');
    if (!projectId) throw new Error('APIDOG_PROJECT_ID is required');
    if (!targetBranchId) throw new Error('APIDOG_TARGET_BRANCH_ID is required');
    const projectName = required('APIDOG_PROJECT_NAME');
    const contractUrl = safeUrl(required('APIDOG_CONTRACT_URL'));
    if (!contractUrl) throw new Error('APIDOG_CONTRACT_URL must be an HTTP or HTTPS URL');
    const rawMap = required('APIDOG_TELEGRAM_USER_MAP');
    let peopleMap: ApidogMergeConfig['peopleMap'];
    try {
      const value = JSON.parse(rawMap);
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.entries(value).every(([id, entry]) => {
        const person = entry as Record<string, unknown> | null;
        return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) && person && typeof person === 'object' && !Array.isArray(person)
          && typeof person.name === 'string' && !!person.name.trim() && typeof person.telegramId === 'string' && /^[1-9]\d{0,19}$/.test(person.telegramId);
      })) throw new Error();
      peopleMap = value;
    } catch { throw new Error('APIDOG_TELEGRAM_USER_MAP must map numeric Apidog IDs to name and numeric telegramId strings'); }
    const rawReviewers = required('APIDOG_MR_REVIEWERS');
    let reviewers: ApidogMergeConfig['reviewers'];
    try {
      const value: unknown = JSON.parse(rawReviewers);
      if (!Array.isArray(value) || value.length !== 2 || !value.every(person =>
        person && typeof person === 'object' && !Array.isArray(person)
        && typeof person.name === 'string' && !!person.name.trim()
        && typeof person.telegramId === 'string' && /^[1-9]\d{0,19}$/.test(person.telegramId))
        || value[0].telegramId === value[1].telegramId) throw new Error();
      reviewers = value;
    } catch { throw new Error('APIDOG_MR_REVIEWERS must contain exactly two names and distinct numeric telegramId strings'); }
    apidogMerge = { projectId, targetBranchId, projectName, contractUrl, peopleMap, reviewers };
  }
  return { apidogMerge, apidogAccessToken, githubWebhookSecret, apidogSignatureKey, apidogSignatureHeader, databasePath, port, sendEnabled,
    telegram, apidogTelegram, githubApiToken: env.GITHUB_API_TOKEN, githubTopic, releasesTopic, reviewTopic, apidogTopic, userMap };
}
