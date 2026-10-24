import type { Delivery, OutgoingMessage } from './store';
import { GithubApiError, type GithubApi, type Commit } from './github-api';
import { commitsLabel, escapeHtml, fitHtml, link, mention, plural, quoteMarkdown, safeUrl, truncate } from './format';

export interface FormatConfig {
  githubTopic?: number;
  reviewTopic?: number;
  userMap?: Record<string, string | number>;
  warn?: (warning: { deliveryId: number; operation: string; errorCode: string }) => void;
}
// Payload is external JSON. Read only the minimal fields needed by each event.
type ObjectValue = Record<string, unknown>;
const obj = (v: unknown): ObjectValue => v && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const login = (v: unknown): string => str(obj(v).login);
const names = (v: unknown): string[] => array(v).map(login).filter(Boolean);
const text = (v: unknown, limit = 180) => escapeHtml(truncate(str(v), limit));
const bot = (v: unknown): boolean => obj(v).type === 'Bot' || login(v).endsWith('[bot]');

export async function formatGithub(delivery: Delivery, api: GithubApi, config: FormatConfig = {}): Promise<OutgoingMessage[]> {
  if (delivery.source !== 'github') return [];
  const p = obj(JSON.parse(new TextDecoder().decode(delivery.raw)));
  const action = str(p.action);
  const repository = obj(p.repository);
  const repo = str(repository.full_name);
  const githubTopic = config.githubTopic ?? 26;
  const reviewTopic = config.reviewTopic ?? 1513;
  const side = repo.startsWith('frontend-park-mail-ru/') ? 'frontend' : repo.startsWith('go-park-mail-ru/') ? 'backend' : repo.split('/').slice(1).join('/');
  const actor = login(p.sender);
  const m = (who: string) => mention(who, config.userMap);
  const mentions = (people: string[]) => [...new Set(people)].slice(0, 10).map(m).join(', ');
  const warn = (operation: string, error: unknown) => {
    const warning = { deliveryId: delivery.id, operation, errorCode: error instanceof GithubApiError ? error.code : 'unavailable' };
    (config.warn ?? (w => console.warn(JSON.stringify(w))))(warning);
  };
  async function enrich<T>(operation: string, run: () => Promise<T>): Promise<T | undefined> {
    try { return await run(); } catch (error) { warn(operation, error); return; }
  }
  const button = (label: string, url: string): OutgoingMessage['button'] => {
    const safe = safeUrl(url); return safe ? { text: label, url: safe } : undefined;
  };
  function card(heading: string, item: ObjectValue, people: string, topic: number, label: string, url = str(item.html_url), body = '', issue = false): OutgoingMessage {
    const title = `${issue ? `#${Number(item.number) || 0} ` : ''}${text(item.title, 240)}`;
    const base = fitHtml(`<b>${heading}</b> · ${text(side, 80)}\n${link(title, url)}\n${people}`);
    let html = base;
    // Bound serialized HTML as well as visible text; never cut a tag/entity in half.
    for (let budget = 700; budget > 0; budget -= 50) {
      const quote = quoteMarkdown(body, budget);
      const candidate = quote ? `${base}\n<blockquote expandable>${quote}</blockquote>` : base;
      if (candidate.length < 4096) { html = candidate; break; }
    }
    return { topic, html, ...(button(label, url) ? { button: button(label, url) } : {}), ...(html !== base ? { fallbackHtml: base } : {}) };
  }

  if (delivery.event === 'issues') {
    const item = obj(p.issue);
    const heads: Record<string, string> = { opened: '🆕 Новая задача', closed: '✅ Задача закрыта', reopened: '♻️ Задача переоткрыта', edited: '✏️ Описание изменено' };
    const heading = heads[action]; if (!heading) return [];
    if (action === 'edited' && (!obj(p.changes).body || !(Date.parse(str(item.updated_at)) - Date.parse(str(item.created_at)) >= 600000))) return [];
    const assigned = names(item.assignees);
    const people = `автор: ${m(actor)}` + (assigned.length ? ` · исполнитель: ${mentions(assigned)}` : '');
    return [card(heading, item, people, githubTopic, 'Открыть задачу', undefined, ['opened', 'edited'].includes(action) ? str(item.body) : '', true)];
  }

  if (delivery.event === 'pull_request') {
    const item = obj(p.pull_request);
    const author = login(item.user);
    const url = str(item.html_url);
    const reviewers = names(item.requested_reviewers);
    const asked = (people: string[]) => `автор: ${text(author, 80)} · ревьювер: ${mentions(people)}`;
    if (['opened', 'ready_for_review'].includes(action)) {
      if (item.draft === true) return [];
      const messages = [card('🔀 Открыт pull request', item, `автор: ${m(author)}` + (reviewers.length ? ` · ревьювер: ${reviewers.slice(0, 10).map(u => text(u, 80)).join(', ')}` : ''), githubTopic, 'Открыть PR')];
      if (reviewers.length) messages.push(card('👀 Запрошено ревью', item, asked(reviewers), reviewTopic, 'Начать ревью', `${url}/files`));
      return messages;
    }
    if (action === 'closed') return [card(item.merged ? `🎉 Влито в ${text(obj(item.base).ref, 80)}` : '🚫 PR закрыт без мержа', item, m(actor), githubTopic, 'Открыть PR')];
    if (action !== 'review_requested' || item.draft === true || !login(p.requested_reviewer)) return [];
    const age = delivery.receivedAt - Date.parse(str(item.created_at));
    if (age < 60000) return [];
    const reviewer = login(p.requested_reviewer);
    let heading = '👀 Запрошено ревью', people = asked([reviewer]), label = 'Начать ревью', target = `${url}/files`;
    const reviews = await enrich('reviews', () => api.reviews(repo, Number(item.number)));
    const last = reviews?.filter(r => r.login === reviewer && r.state.toUpperCase() !== 'PENDING').at(-1);
    if (last) {
      heading = '🔁 Повторное ревью';
      const verdict: Record<string, string> = { CHANGES_REQUESTED: '✋ правки', APPROVED: '👍 апрув', DISMISSED: 'ревью снято' };
      people += `\nпосле твоего ревью (${verdict[last.state.toUpperCase()] ?? '💬 комментарии'})`;
      const head = str(obj(item.head).sha);
      if (last.commitId && head) {
        const comparison = await enrich('compare', () => api.compare(repo, last.commitId!, head));
        if (comparison?.aheadBy !== undefined) {
          people += comparison.aheadBy ? `: ${commitsLabel(comparison.aheadBy)}` : ': новых коммитов нет';
          if (comparison.aheadBy > 0) { label = 'Что изменилось'; target = `${url}/files/${encodeURIComponent(last.commitId)}..${encodeURIComponent(head)}`; }
        }
      }
    }
    return [card(heading, item, people, reviewTopic, label, target)];
  }

  if (delivery.event === 'issue_comment') {
    const comment = obj(p.comment), item = obj(p.issue), by = login(comment.user), author = login(item.user);
    if (action !== 'created' || bot(comment.user) || str(comment.body).startsWith('<!-- auto -->')) return [];
    const isPr = item.pull_request != null;
    let recipients: string[];
    if (isPr && by === author) {
      const embedded = obj(p.pull_request).requested_reviewers;
      recipients = Array.isArray(embedded) ? names(embedded) : (await enrich('pull_request', () => api.pullRequest(repo, Number(item.number))))?.requestedReviewers ?? [];
    } else recipients = isPr ? [author] : [...names(item.assignees), author];
    recipients = recipients.filter(u => u && u !== by);
    const people = `от: ${text(by, 80)}` + (recipients.length ? ` · для: ${mentions(recipients)}` : '');
    return [card(isPr ? '💬 Комментарий к PR' : '💬 Комментарий', item, people, isPr ? reviewTopic : githubTopic, 'Открыть комментарий', str(comment.html_url), str(comment.body), !isPr)];
  }

  if (delivery.event === 'pull_request_review') {
    const item = obj(p.pull_request), review = obj(p.review), by = login(review.user), author = login(item.user);
    const state = str(review.state).toLowerCase();
    // Task 5 persists commented reviews BEFORE marking a delivery prepared.
    if (action !== 'submitted' || !['approved', 'changes_requested'].includes(state) || by === author || bot(review.user)) return [];
    let people = `автор: ${m(author)} · ревьювер: ${text(by, 80)}`;
    const reviews = await enrich('reviews', () => api.reviews(repo, Number(item.number)));
    let count: number | undefined, target = str(review.html_url);
    if (reviews) {
      const current = reviews.find(r => r.id === review.id);
      const at = Date.parse(current?.submittedAt ?? str(review.submitted_at));
      const preceding = reviews.filter(r => r.login === by && r.state !== 'PENDING' && Date.parse(r.submittedAt ?? '') <= at)
        .sort((a, b) => Date.parse(b.submittedAt!) - Date.parse(a.submittedAt!));
      const series = [];
      let lastAt = at;
      for (const r of preceding) {
        const time = Date.parse(r.submittedAt!);
        if (lastAt - time >= 180000) break;
        series.push(r); lastAt = time;
      }
      const comments = await enrich('review_comments', () => api.reviewComments(repo, Number(item.number)));
      if (comments) {
        const ids = new Set(series.length ? series.map(r => r.id) : [Number(review.id)]);
        count = comments.filter(c => ids.has(c.reviewId)).length + (series.length ? series.filter(r => r.body?.trim()).length : str(review.body).trim() ? 1 : 0);
        target = series.at(-1)?.htmlUrl ?? target;
      }
    }
    if (count) people += `\n${plural(count, 'комментарий', 'комментария', 'комментариев')}`;
    const message = card(state === 'approved' ? '👍 Апрув' : '✋ Запрошены правки', item, people, reviewTopic, 'Открыть ревью', target);
    if (count === 0) delete message.button;
    return [message];
  }

  if (delivery.event !== 'push' || p.deleted === true) return [];
  const branch = str(p.ref).replace(/^refs\/heads\//, '');
  const defaultBranch = str(repository.default_branch) || 'main';
  let commits: Commit[] = array(p.commits).map(obj).filter(c => c.distinct === true).map(c => ({ sha: str(c.id), message: str(c.message) }));
  let heading = `⚒️ ${commitsLabel(commits.length)}`, note = '', label = 'Открыть изменения', target = str(p.compare);
  if (p.forced === true) {
    heading = `⚠️ ${commitsLabel(commits.length)} (force-push)`;
    try {
      const current = await api.compare(repo, defaultBranch, str(p.after));
      heading = '⚠️ force-push'; label = 'Ветка целиком';
      target = `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(branch)}`;
      commits = current.commits;
      if (!commits.length) note = `ветка сброшена до ${text(defaultBranch, 80)}`;
      else {
        note = `ветка переписана: ${commitsLabel(commits.length)} поверх ${text(defaultBranch, 80)}`;
        const previous = await enrich('compare_previous', () => api.compare(repo, defaultBranch, str(p.before)));
        if (previous) {
          const old = new Set(previous.commits.map(c => c.message.split('\n')[0]));
          commits = commits.filter(c => !old.has(c.message.split('\n')[0]));
          note += commits.length ? `, новых — ${commits.length}` : ', новых коммитов нет';
        }
      }
    } catch (error) {
      warn('compare', error);
      if (error instanceof GithubApiError && error.code === 'no_common_ancestor') {
        heading = '⚠️ force-push'; note = `у ветки нет общей истории с ${text(defaultBranch, 80)}`;
      } else if (!commits.length) return [];
    }
  } else if (!commits.length) return [];
  const branchUrl = `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}/tree/${encodeURIComponent(branch)}`;
  const header = `<b>${heading}</b> · ${text(side, 80)} · ${link(text(branch, 80), branchUrl)}`;
  const lines = commits.slice(0, 10).map(c => `• ${text(c.sha.slice(0, 7))} ${text(c.message.split('\n')[0], 40)}`);
  const html = fitHtml([header, note, ...lines, commits.length > 10 ? `…и ещё ${commits.length - 10}` : '', m(actor)].filter(Boolean).join('\n'));
  const messages: OutgoingMessage[] = [{ topic: githubTopic, html, ...(button(label, target) ? { button: button(label, target) } : {}) }];
  if (p.forced === true) {
    const closed = await enrich('recent_closed_pull_requests', () => api.recentClosedPullRequests(repo, branch));
    for (const pr of closed ?? []) {
      const closedAt = Date.parse(pr.closedAt);
      const pushedAt = typeof repository.pushed_at === 'number' ? repository.pushed_at * 1000 : undefined;
      const nearPush = pushedAt !== undefined ? Math.abs(closedAt - pushedAt) <= 10000 : closedAt <= delivery.receivedAt && delivery.receivedAt - closedAt < 300000;
      if (!pr.merged && pr.forcePushClosed && nearPush) messages.push(card('🚫 PR закрыт без мержа', { title: pr.title, html_url: pr.htmlUrl },
        `автор: ${m(pr.author)}\nGitHub закрыл PR после force-push: у ветки не осталось изменений или общей истории с ${text(defaultBranch, 80)}`, githubTopic, 'Открыть PR'));
    }
  }
  return messages;
}
