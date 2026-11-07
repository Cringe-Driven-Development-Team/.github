import type { BotIdentity, Config, RepoConfig } from './config';

export interface IssueRef { repo: string; number: number; url: string }
export interface Context { chatId: string; threadId?: number; messageId: number }
export interface Actor { id: string; username?: string }
export type Command = { name: 'issue'; title: string; body: string }
  | { name: 'sprint'; username?: string }
  | { name: 'close' | 'assign' | 'assignme' | 'unassign' | 'tosprint'; target: IssueRef; username?: string };
export type Input = { updateId: number; context: Context; actor: Actor } & (
  { kind: 'command'; command: Command }
  | { kind: 'choice'; requestId: string; repoIndex: number; callbackId: string; promptMessageId: number }
  | { kind: 'error'; message: string; callbackId?: string }
);

export class CommandError extends Error {
  constructor(message: string, public context: Context, public actor: Actor, public updateId: number, public callbackId?: string) {
    super(message);
    this.name = 'CommandError';
  }
}

export function normalizeTitle(title: string, repo: RepoConfig, repos: RepoConfig[]): string {
  const value = title.trim();
  if (!value) throw new Error('Укажите непустой заголовок задачи.');
  const prefix = repos.flatMap(r => r.prefixes).find(p => value.toLowerCase().startsWith(p.toLowerCase()));
  if (prefix && !repo.prefixes.includes(prefix)) throw new Error('Префикс относится к другому репозиторию.');
  return prefix ? value : `${repo.defaultPrefix} ${value}`;
}

export function parseIssueUrl(value: string, config: Config): IssueRef {
  const invalid = () => new Error('Нужна полная HTTPS-ссылка на задачу разрешённого репозитория GitHub.');
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (!/^https:\/\/github\.com(?::443)?\//i.test(value) || url.protocol !== 'https:' || url.hostname !== 'github.com'
    || url.username || url.password || url.port || url.search || (url.hash && !/^#issuecomment-[1-9]\d*$/.test(url.hash))) throw invalid();
  const match = /^\/Cringe-Driven-Development-Team\/([^/]+)\/issues\/([1-9]\d*)$/i.exec(url.pathname);
  const repo = config.repositories.find(r => r.name.toLowerCase() === match?.[1]?.toLowerCase());
  const number = Number(match?.[2]);
  if (!repo || !Number.isSafeInteger(number) || number <= 0) throw invalid();
  return { repo: repo.name, number, url: `https://github.com/Cringe-Driven-Development-Team/${repo.name}/issues/${number}` };
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const telegramId = (value: unknown): string | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value !== 0 ? String(value) : undefined;

function cardTarget(raw: unknown, context: Context, config: Config, bot: BotIdentity): IssueRef {
  const card = object(raw), from = object(card.from), chat = object(card.chat);
  if (!integer(card.message_id) || telegramId(chat.id) !== context.chatId || card.message_thread_id !== context.threadId
    || from.is_bot !== true || ![bot.id, ...config.notificationBotIds].includes(telegramId(from.id) ?? '')
    || card.forward_origin !== undefined || card.forward_date !== undefined || card.forward_from !== undefined) {
    throw new Error('Ответьте на оригинальную карточку в этом топике или укажите полную ссылку.');
  }
  const text = typeof card.text === 'string' ? card.text : '';
  const entities = Array.isArray(card.entities) ? card.entities.map(object) : [];
  const ranges = entities.filter(e => ['blockquote', 'expandable_blockquote'].includes(String(e.type)));
  const targets: IssueRef[] = [];
  for (const entity of entities) {
    const { offset, length } = entity;
    if (entity.type !== 'text_link' || !Number.isSafeInteger(offset) || !integer(length) || typeof offset !== 'number'
      || offset < 0 || offset + length > text.length || typeof entity.url !== 'string') continue;
    if (ranges.some(q => typeof q.offset === 'number' && typeof q.length === 'number' && offset < q.offset + q.length && offset + length > q.offset)) continue;
    const label = text.slice(offset, offset + length);
    const header = /^(?:([a-z0-9_.-]+))?#([1-9]\d*)(?:[ \t][^\n]*)?$/i.exec(label);
    if (!header) continue;
    const target = parseIssueUrl(entity.url, config);
    if (Number(header[2]) !== target.number || (header[1] && header[1].toLowerCase() !== target.repo.toLowerCase())) throw new Error('Ссылка и заголовок карточки не совпадают. Укажите полную ссылку.');
    targets.push(target);
  }
  const keyboard = object(card.reply_markup).inline_keyboard;
  if (Array.isArray(keyboard)) for (const row of keyboard) {
    if (!Array.isArray(row)) continue;
    for (const rawButton of row) {
      const button = object(rawButton);
      if (['Открыть задачу', 'Открыть комментарий'].includes(String(button.text)) && typeof button.url === 'string') targets.push(parseIssueUrl(button.url, config));
    }
  }
  const unique = new Map(targets.map(target => [target.url, target]));
  if (unique.size !== 1) throw new Error('Не удалось однозначно выбрать задачу из карточки. Укажите полную ссылку.');
  return unique.values().next().value!;
}

export function decodeUpdate(raw: unknown, config: Config, bot: BotIdentity): Input | null {
  const update = object(raw);
  if (!integer(update.update_id) && update.update_id !== 0) return null;
  if (update.edited_message !== undefined || update.edited_channel_post !== undefined) return null;
  const callback = object(update.callback_query);
  const isCallback = update.callback_query !== undefined;
  const msg = object(isCallback ? callback.message : update.message);
  const from = object(isCallback ? callback.from : msg.from);
  const actorId = telegramId(from.id), chatId = telegramId(object(msg.chat).id);
  if (!actorId || !config.users.some(u => u.telegramId === actorId) || from.is_bot !== false || msg.sender_chat !== undefined
    || chatId !== config.chatId || !integer(msg.message_id) || (msg.message_thread_id !== undefined && !integer(msg.message_thread_id))) return null;
  const context: Context = { chatId, messageId: msg.message_id, ...(msg.message_thread_id === undefined ? {} : { threadId: msg.message_thread_id as number }) };
  const actor: Actor = { id: actorId, ...(typeof from.username === 'string' ? { username: from.username } : {}) };
  const updateId = update.update_id as number;
  const callbackId = typeof callback.id === 'string' ? callback.id : undefined;
  const fail = (message: string): never => { throw new CommandError(message, context, actor, updateId, callbackId); };
  const base = { context, actor, updateId };
  if (isCallback) {
    if (telegramId(object(msg.from).id) !== bot.id || !callbackId) return null;
    const data = typeof callback.data === 'string' ? callback.data : '';
    const match = /^repo:([a-z0-9_-]+):(0|[1-9]\d*)$/i.exec(data);
    const repoIndex = Number(match?.[2]);
    if (!match || new TextEncoder().encode(data).length > 64 || !Number.isSafeInteger(repoIndex) || !config.repositories[repoIndex]) fail('Некорректный выбор репозитория. Повторите /issue.');
    return { ...base, kind: 'choice', requestId: match![1]!, repoIndex, callbackId, promptMessageId: context.messageId };
  }
  if (typeof msg.text !== 'string') return null;
  const match = /^\/([a-z]+)(?:@([a-z0-9_]+))?(?=\s|$)/i.exec(msg.text);
  if (!match || (match[2] && match[2].toLowerCase() !== bot.username.toLowerCase())) return null;
  const name = match[1]!.toLowerCase();
  if (!['issue', 'sprint', 'close', 'assign', 'assignme', 'unassign', 'tosprint'].includes(name)) return null;
  const rest = msg.text.slice(match[0].length);
  if (name === 'issue') {
    const newline = rest.indexOf('\n');
    const title = (newline < 0 ? rest : rest.slice(0, newline)).trim();
    if (!title) fail('Формат: /issue Заголовок, описание — со следующей строки.');
    return { ...base, kind: 'command', command: { name, title, body: newline < 0 ? '' : rest.slice(newline + 1) } };
  }
  const args = rest.trim() ? rest.trim().split(/\s+/) : [];
  let username: string | undefined;
  if (name === 'assign' || name === 'unassign' || (name === 'sprint' && args.length)) {
    const alias = args.shift();
    if (!alias || !/^@[a-z0-9_]+$/i.test(alias)) fail(`Формат: /${name} @telegram_username${name === 'sprint' ? '' : ' [URL]'}`);
    username = alias!.slice(1).toLowerCase();
    if (!config.users.some(u => u.username === username)) fail('Этот Telegram username не настроен. Обратитесь к владельцу конфигурации.');
  }
  if (name === 'sprint') {
    if (args.length) fail('Формат: /sprint [@telegram_username]');
    return { ...base, kind: 'command', command: { name, ...(username === undefined ? {} : { username }) } };
  }
  if (args.length > 1 || (args.length && msg.reply_to_message !== undefined) || (!args.length && msg.reply_to_message === undefined)) fail('Выберите один способ: ответ на карточку или полная ссылка на issue.');
  let target: IssueRef;
  try { target = args.length ? parseIssueUrl(args[0]!, config) : cardTarget(msg.reply_to_message, context, config, bot); }
  catch (error) { fail(error instanceof Error ? error.message : 'Не удалось выбрать задачу.'); }
  return { ...base, kind: 'command', command: { name: name as 'close' | 'assign' | 'assignme' | 'unassign' | 'tosprint', target: target!, ...(username === undefined ? {} : { username }) } };
}
