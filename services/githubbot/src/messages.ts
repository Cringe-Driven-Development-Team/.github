import { escapeHtml, link, mention } from '../../webhook-alerts/src/format';
import type { RepoConfig, UserConfig } from './config';
import type { Issue } from './github';
import type { Board, Iteration, ProjectItem } from './projects';

export interface Outgoing { html: string; keyboard?: { text: string; url?: string; callback_data?: string }[][] }

export function issueCard(issue: Issue, result: string): Outgoing {
  return { html: `🔔 ${link(`${escapeHtml(issue.ref.repo)}#${issue.ref.number} ${escapeHtml(issue.title)}`, issue.ref.url)}\n${escapeHtml(result)}`,
    keyboard: [[{ text: 'Открыть задачу', url: issue.ref.url }]] };
}

export function repositoryPrompt(requestId: string, repos: RepoConfig[]): Outgoing {
  return { html: 'Выберите репозиторий', keyboard: repos.map((repo, index) => [{ text: repo.name, callback_data: `repo:${requestId}:${index}` }]) };
}

export function sprintMessages(board: Board, iteration: Iteration, users: UserConfig[], login?: string): Outgoing[] {
  const key = (login: string) => login.toLowerCase();
  const items = [...new Map(board.items.filter(item => !item.archived && item.sprintId === iteration.id
    && (login === undefined || item.issue.assignees.some(a => key(a) === key(login))))
    .map(item => [item.issue.nodeId, item])).values()];
  const end = new Date(`${iteration.startDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + iteration.duration);
  const heading = `<b>${escapeHtml(iteration.title)}</b> · ${iteration.startDate} — ${end.toISOString().slice(0, 10)}\nУникальных задач: ${items.length}`;
  if (!items.length) return [{ html: `${heading}\nзадач нет` }];
  const groups = new Map<string, ProjectItem[]>();
  for (const item of items) {
    const assignees = login === undefined ? [...new Set(item.issue.assignees.map(key))] : [key(login)];
    for (const assignee of assignees.length ? assignees : ['']) {
      if (!groups.has(assignee)) groups.set(assignee, []);
      groups.get(assignee)!.push(item);
    }
  }
  const messages: Outgoing[] = [];
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  for (const [assignee, group] of [...groups].sort(([a], [b]) => a === '' ? 1 : b === '' ? -1 : compare(a, b))) {
    const user = users.find(u => key(u.githubLogin) === assignee);
    const label = assignee ? user ? mention(user.username, { [user.username]: user.telegramId }) : escapeHtml(assignee) : 'Без исполнителя';
    const prefix = `${heading}\n\n<b>${label}</b>`;
    let html = prefix;
    group.sort((a, b) => compare(a.issue.ref.repo, b.issue.ref.repo) || a.issue.ref.number - b.issue.ref.number);
    for (const item of group) {
      const { issue } = item;
      const start = `• ${link(`${escapeHtml(issue.ref.repo)}#${issue.ref.number}`, issue.ref.url)} · `;
      const suffix = ` · ${escapeHtml(item.status ?? 'без статуса')}${issue.state === 'CLOSED' ? ' · CLOSED' : ''}`;
      // Escape individual code points so a long title never splits an entity or surrogate pair.
      const tokens = Array.from(issue.title, escapeHtml);
      let offset = 0;
      do {
        const budget = 4096 - prefix.length - 1 - start.length - suffix.length;
        if (budget < 6) throw new Error('Sprint summary heading or Status is too long');
        let title = '';
        while (offset < tokens.length && title.length + tokens[offset]!.length <= budget) title += tokens[offset++]!;
        const line = `${start}${title}${suffix}`;
        if (html.length + 1 + line.length > 4096) { messages.push({ html }); html = prefix; }
        html += `\n${line}`;
      } while (offset < tokens.length);
    }
    if (html !== prefix) messages.push({ html });
  }
  return messages;
}
