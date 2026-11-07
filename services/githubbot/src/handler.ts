import { normalizeTitle, parseIssueUrl, type Context } from './commands';
import type { Config } from './config';
import { ApiError, type Github } from './github';
import { issueCard, repositoryPrompt, sprintMessages, type Outgoing } from './messages';
import { currentIteration, type Projects } from './projects';
import type { Job, Store } from './store';
import { escapeHtml } from '../../webhook-alerts/src/format';

export type Send = (context: Context, message: Outgoing) => Promise<number>;
export type AnswerCallback = (id: string, text: string) => Promise<void>;
export interface HandlerDeps {
  config: Config;
  store: Store;
  github: Github;
  projects: Projects;
  send: Send;
  answerCallback: AnswerCallback;
  now: () => Date;
}

const uncertainWarning = 'Результат создания issue в GitHub неизвестен. Проверьте репозиторий вручную; GitHubBot не будет повторять создание.';
const partialResult = 'Задача создана, но настройка Scrumban не подтверждена. Проверьте Status и Sprint вручную.';

export async function handleJob(saved: Job, deps: HandlerDeps): Promise<void> {
  const { store, config, github, projects } = deps;
  let job = store.job(saved.id);
  const { input } = job;
  const actor = config.users.find(user => user.telegramId === input.actor.id);
  if (!actor || input.context.chatId !== config.chatId) {
    store.checkpoint(job.id, { phase: 'done' });
    return;
  }
  if (input.actor.username?.replace(/^@/, '').toLowerCase() !== actor.username) store.blockAlias(actor.telegramId, actor.username);
  if (job.phase === 'done' || job.phase === 'waiting_repo' || job.nextAttemptAt > deps.now().getTime()) return;

  const checkpoint = (patch: Parameters<Store['checkpoint']>[1]) => {
    store.checkpoint(job.id, patch); job = store.job(job.id);
  };
  const output = (messages: Outgoing[], phase: 'reply_pending' | 'uncertain' = 'reply_pending') => {
    checkpoint({ output: messages, nextOutput: 0, phase, attempts: 0, nextAttemptAt: 0 });
  };
  const hint = (message: string) => output([{ html: escapeHtml(message) }]);
  const retry = (error: unknown, phase = job.phase): boolean => {
    const attempts = job.attempts + 1;
    if (error instanceof ApiError && error.kind === 'retryable' && attempts < 3) {
      checkpoint({ phase, attempts, nextAttemptAt: deps.now().getTime() + (error.retryAfterMs ?? 5000) });
      return true;
    }
    checkpoint({ attempts });
    return false;
  };
  const deliver = async () => {
    while (job.nextOutput < (job.output?.length ?? 0)) {
      try {
        const messageId = await deps.send(input.context, job.output![job.nextOutput]!);
        if (job.choiceId && !job.selectedRepo && job.phase === 'reply_pending') {
          store.bindPrompt(job.choiceId, messageId);
          job = store.job(job.id);
          return;
        }
        checkpoint({ nextOutput: job.nextOutput + 1, attempts: 0, nextAttemptAt: 0 });
      } catch (error) {
        if (retry(error)) return;
        // Retain the unsent outbox for diagnosis when Telegram cannot deliver the result.
        console.error(`GitHubBot job ${job.id}: delivery failed after ${job.attempts} attempt(s)`);
        checkpoint({ phase: 'done' });
        return;
      }
    }
    if (job.phase === 'reply_pending') checkpoint({ phase: 'done' });
  };

  if (job.phase === 'uncertain') {
    if (!job.output?.length) output([{ html: uncertainWarning }], 'uncertain');
    await deliver(); return;
  }
  if (input.kind === 'choice') {
    let text = 'Репозиторий выбран.';
    try { store.choose(input.requestId, input.actor.id, input.context, input.promptMessageId, input.repoIndex, deps.now().getTime()); }
    catch { text = 'Этот выбор недоступен: выберите свою актуальную кнопку или повторите /issue.'; }
    try { await deps.answerCallback(input.callbackId, text); checkpoint({ phase: 'done' }); }
    catch (error) {
      if (!retry(error)) { console.error(`GitHubBot job ${job.id}: callback delivery failed`); checkpoint({ phase: 'done' }); }
    }
    return;
  }
  if (input.kind === 'error') {
    if (job.phase !== 'reply_pending') hint(input.message);
    await deliver(); return;
  }

  const { command } = input;
  const targetUser = command.name !== 'issue' && command.username !== undefined
    ? config.users.find(user => user.username === command.username) : undefined;
  if (command.name !== 'issue' && command.username !== undefined
    && (!targetUser || store.isAliasBlocked(targetUser.telegramId, targetUser.username))) {
    const html = 'Этот Telegram username не настроен или устарел. Обратитесь к владельцу конфигурации.';
    if (job.output?.[0]?.html !== html) hint(html);
    await deliver(); return;
  }
  if (job.phase === 'reply_pending') { await deliver(); return; }
  if (job.phase === 'issue_created' || (job.phase === 'creating' && job.issue)) {
    if (job.issue) output([issueCard(job.issue, partialResult)]);
    else hint('Ошибка: сохранённая задача не найдена. Проверьте GitHub вручную.');
    await deliver(); return;
  }
  if (job.phase === 'creating') {
    output([{ html: uncertainWarning }], 'uncertain'); await deliver(); return;
  }

  try {
    if (command.name === 'issue') {
      const repoName = job.selectedRepo ?? (job.choiceId ? undefined : config.topics.find(topic => topic.threadId === input.context.threadId)?.repository);
      if (!repoName) {
        const requestId = store.createChoice(job.id, config.repositories.map(repo => repo.name), deps.now().getTime() + 86_400_000);
        const repositories = store.choiceRepositories(requestId).map(name => ({ name, defaultPrefix: '', prefixes: [] }));
        output([repositoryPrompt(requestId, repositories)]); await deliver(); return;
      }
      const repo = config.repositories.find(repo => repo.name === repoName);
      if (!repo) { hint('Этот репозиторий больше не разрешён. Повторите /issue.'); await deliver(); return; }
      let title: string;
      try { title = normalizeTitle(command.title, repo, config.repositories); }
      catch (error) { hint((error as Error).message); await deliver(); return; }
      checkpoint({ phase: 'creating', selectedRepo: repo.name });
      const issue = await github.createIssue(repo.name, title, command.body);
      checkpoint({ phase: 'issue_created', issue });
      try { await projects.initializeIssue(issue); output([issueCard(issue, 'Задача создана в Scrumban: Backlog, Sprint не задан.')]); }
      catch {
        console.error(`GitHubBot job ${job.id}: issue_created initialization failed`);
        output([issueCard(issue, partialResult)]);
      }
    } else if (command.name === 'sprint') {
      checkpoint({ phase: 'ready' });
      const board = await projects.readBoard();
      const users = config.users.filter(user => !store.isAliasBlocked(user.telegramId, user.username));
      output(sprintMessages(board, currentIteration(board.iterations, deps.now()), users, targetUser?.githubLogin));
    } else {
      try { parseIssueUrl(command.target.url, config); }
      catch { hint('Нужна ссылка на задачу разрешённого репозитория.'); await deliver(); return; }
      if (!config.repositories.some(repo => repo.name === command.target.repo)) {
        hint('Этот репозиторий больше не разрешён.'); await deliver(); return;
      }
      checkpoint({ phase: 'mutating' });
      let issue = await github.getIssue(command.target), result: string;
      if (command.name === 'close') {
        if (issue.state !== 'CLOSED') issue = await github.closeIssue(issue.ref);
        result = 'Задача закрыта.';
      } else if (command.name === 'tosprint') {
        const changed = await projects.toCurrentSprint(issue, deps.now());
        issue = changed.item.issue;
        result = `Sprint: ${changed.iteration.title}. Status: ${changed.item.status ?? 'не задан'}.${changed.statusChangedExternally ? ' Status изменён извне.' : ''}`;
      } else {
        const user = command.name === 'assignme' ? actor : targetUser;
        if (!user) { hint('Укажите настроенный Telegram username.'); await deliver(); return; }
        const assigned = issue.assignees.some(login => login.toLowerCase() === user.githubLogin.toLowerCase());
        if (command.name === 'unassign') {
          if (assigned) issue = await github.removeAssignee(issue.ref, user.githubLogin);
          result = `Исполнитель ${user.githubLogin} снят.`;
        } else {
          if (!assigned) {
            if (!await github.canAssign(issue.ref.repo, user.githubLogin)) {
              hint(`Пользователя ${user.githubLogin} нельзя назначить в ${issue.ref.repo}. Проверьте доступ к репозиторию.`); await deliver(); return;
            }
            issue = await github.addAssignee(issue.ref, user.githubLogin);
          }
          result = `Исполнитель: ${user.githubLogin}.`;
        }
      }
      checkpoint({ issue }); output([issueCard(issue, result)]);
    }
  } catch (error) {
    job = store.job(job.id);
    console.error(`GitHubBot job ${job.id}: ${job.phase} failed`);
    if (command.name === 'issue' && job.issue) output([issueCard(job.issue, partialResult)]);
    else if (job.phase === 'creating' && (!(error instanceof ApiError) || error.kind === 'uncertain')) {
      output([{ html: uncertainWarning }], 'uncertain');
    } else if (retry(error, 'ready')) return;
    else hint('Ошибка выполнения команды в GitHub. Проверьте права и параметры; при необходимости повторите команду.');
  }
  await deliver();
}
