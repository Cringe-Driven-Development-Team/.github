export interface Config {
  githubWebhookSecret: string;
  databasePath: string;
  port: number;
  sendEnabled: boolean;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const githubWebhookSecret = env.GITHUB_WEBHOOK_SECRET;
  if (!githubWebhookSecret?.trim()) throw new Error('GITHUB_WEBHOOK_SECRET is required');

  const portText = env.PORT ?? '8080';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }

  const databasePath = env.DATABASE_PATH ?? '/data/queue.sqlite';
  if (!databasePath.trim()) throw new Error('DATABASE_PATH must not be empty');

  const sendEnabled = env.WEBHOOK_ALERTS_SEND_ENABLED ?? 'false';
  if (sendEnabled !== 'true' && sendEnabled !== 'false') {
    throw new Error('WEBHOOK_ALERTS_SEND_ENABLED must be true or false');
  }

  return { githubWebhookSecret, databasePath, port, sendEnabled: sendEnabled === 'true' };
}
