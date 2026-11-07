export interface RepoConfig { name: string; defaultPrefix: string; prefixes: string[] }
export interface UserConfig { telegramId: string; username: string; githubLogin: string }
export interface BotIdentity { id: string; username: string }
export interface Config {
  chatId: string;
  notificationBotIds: string[];
  repositories: RepoConfig[];
  topics: { threadId: number; repository: string }[];
  users: UserConfig[];
  telegramToken: string;
  githubToken: string;
  databasePath: string;
  telegramProxyUrl?: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const required = (name: string): string => {
    const value = env[name];
    if (!value?.trim()) throw new ConfigError(`${name} is required`);
    return value;
  };
  const telegramToken = required('TELEGRAM_BOT_TOKEN');
  const githubToken = required('GITHUB_TOKEN');
  const raw = required('GITHUBBOT_CONFIG_JSON');
  const databasePath = env.DATABASE_PATH ?? '/data/githubbot.sqlite';
  if (!databasePath.trim()) throw new ConfigError('DATABASE_PATH must not be empty');
  const telegramProxyUrl = env.TELEGRAM_PROXY_URL;
  if (telegramProxyUrl !== undefined) {
    try {
      const url = new URL(telegramProxyUrl);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error();
    } catch { throw new ConfigError('TELEGRAM_PROXY_URL must be an HTTP or HTTPS URL'); }
  }
  try {
    const c = JSON.parse(raw) as Config;
    const positiveId = (id: unknown): id is string => typeof id === 'string' && /^[1-9]\d*$/.test(id);
    const unique = (values: string[]) => new Set(values.map(x => x.toLowerCase())).size === values.length;
    if (!c || typeof c !== 'object' || typeof c.chatId !== 'string' || !/^-[1-9]\d*$/.test(c.chatId)
      || !Array.isArray(c.notificationBotIds) || !c.notificationBotIds.every(positiveId) || !unique(c.notificationBotIds)
      || !Array.isArray(c.repositories) || !c.repositories.length
      || !Array.isArray(c.topics) || !Array.isArray(c.users) || !c.users.length) throw new Error();
    for (const repo of c.repositories) {
      if (!repo || typeof repo.name !== 'string' || !/^[a-z0-9_.-]+$/i.test(repo.name)
        || !Array.isArray(repo.prefixes) || !repo.prefixes.length
        || !repo.prefixes.every(p => typeof p === 'string' && /^[^\s.]+\.$/.test(p))
        || !unique(repo.prefixes) || !repo.prefixes.includes(repo.defaultPrefix)) throw new Error();
    }
    if (!unique(c.repositories.map(r => r.name))) throw new Error();
    for (const topic of c.topics) {
      if (!topic || !Number.isSafeInteger(topic.threadId) || topic.threadId <= 0
        || !c.repositories.some(r => r.name === topic.repository)) throw new Error();
    }
    if (new Set(c.topics.map(t => t.threadId)).size !== c.topics.length) throw new Error();
    const users = c.users.map(user => {
      if (!user || !positiveId(user.telegramId) || typeof user.username !== 'string'
        || !/^@?[a-z0-9_]+$/i.test(user.username) || typeof user.githubLogin !== 'string'
        || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(user.githubLogin)) throw new Error();
      return { telegramId: user.telegramId, username: user.username.replace(/^@/, '').toLowerCase(), githubLogin: user.githubLogin };
    });
    if (!unique(users.map(u => u.telegramId)) || !unique(users.map(u => u.username)) || !unique(users.map(u => u.githubLogin))) throw new Error();
    return { chatId: c.chatId, notificationBotIds: c.notificationBotIds, repositories: c.repositories,
      topics: c.topics, users, telegramToken, githubToken, databasePath, ...(telegramProxyUrl === undefined ? {} : { telegramProxyUrl }) };
  } catch { throw new ConfigError('GITHUBBOT_CONFIG_JSON must contain valid, unique chat, bot, repository, topic and user configuration'); }
}
