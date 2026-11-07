import type { BotIdentity, Config } from '../src/config';

export const bot: BotIdentity = { id: '901', username: 'githubbot' };

export function config(): Config {
  return {
    telegramToken: 'fake-telegram-token', githubToken: 'fake-github-token', databasePath: '/tmp/githubbot-test.sqlite',
    chatId: '-1001', notificationBotIds: ['900'],
    repositories: [
      { name: 'backend', defaultPrefix: 'Backend.', prefixes: ['Backend.'] },
      { name: 'frontend', defaultPrefix: 'Frontend.', prefixes: ['Frontend.', 'BFF.'] },
      { name: 'figma', defaultPrefix: 'Figma.', prefixes: ['Figma.'] },
    ],
    topics: [{ threadId: 11, repository: 'backend' }, { threadId: 12, repository: 'frontend' }, { threadId: 13, repository: 'figma' }],
    users: [{ telegramId: '101', username: 'alice', githubLogin: 'octo' }],
  };
}

export function message(text: string, reply?: unknown): unknown {
  return {
    update_id: 1,
    message: {
      message_id: 10, date: 1, chat: { id: -1001, type: 'supergroup' }, message_thread_id: 11,
      from: { id: 101, is_bot: false, first_name: 'Alice', username: 'alice' }, text,
      ...(reply === undefined ? {} : { reply_to_message: reply }),
    },
  };
}

export function callback(requestId: string, repoIndex: number, actorId = '101'): unknown {
  return {
    update_id: 2,
    callback_query: {
      id: 'callback-1', chat_instance: 'test-chat', data: `repo:${requestId}:${repoIndex}`,
      from: { id: Number(actorId), is_bot: false, first_name: 'Alice', username: 'alice' },
      message: {
        message_id: 20, date: 1, chat: { id: -1001, type: 'supergroup' }, message_thread_id: 14,
        from: { id: 901, is_bot: true, first_name: 'GitHubBot', username: 'githubbot' }, text: 'Выберите репозиторий',
      },
    },
  };
}
