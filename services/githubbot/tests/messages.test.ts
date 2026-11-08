import { expect, test } from 'bun:test';
import * as messages from '../src/messages';
import { issueCard, repositoryPrompt, sprintMessages } from '../src/messages';
import type { Board, ProjectItem } from '../src/projects';
import { bot, config, message } from './fixtures';
import { decodeUpdate } from '../src/commands';

const iteration = { id: 's8', title: 'Sprint 8', startDate: '2026-11-02', duration: 7 };
function item(number: number, overrides: Partial<ProjectItem> = {}): ProjectItem {
  return { id: `item${number}`, archived: false, sprintId: 's8', status: 'In progress', issue: {
    ref: { repo: 'backend', number, url: `https://github.com/Cringe-Driven-Development-Team/backend/issues/${number}` },
    nodeId: `issue${number}`, title: '<b>&😀 task ' + number, state: 'CLOSED', assignees: number % 3 === 0 ? [] : number % 3 === 1 ? ['octo', 'unknown'] : ['octo'],
  }, ...overrides };
}
const board = (items: ProjectItem[]): Board => ({ id: 'p', sprintFieldId: 's', statusFieldId: 'st', backlogOptionId: 'b', iterations: [iteration], items });

test('card is escaped and its keyboard is trusted by the reply parser', () => {
  const issue = item(7).issue;
  const card = issueCard(issue, 'Сохранено <&>');
  expect(card.html).toContain('&lt;b&gt;&amp;😀');
  expect(card.html).toContain('Сохранено &lt;&amp;&gt;');
  const raw = message('/close', { message_id: 9, chat: { id: -1001 }, message_thread_id: 11,
    from: { id: Number(bot.id), is_bot: true }, text: 'card', reply_markup: { inline_keyboard: card.keyboard } });
  expect(decodeUpdate(raw, config(), bot)).toMatchObject({ command: { target: issue.ref } });
});

test('repository buttons carry request identity and allowlist indices', () => {
  expect(repositoryPrompt('request-7', config().repositories).keyboard).toEqual([
    [{ text: 'backend', callback_data: 'repo:request-7:0' }],
    [{ text: 'frontend', callback_data: 'repo:request-7:1' }],
    [{ text: 'figma', callback_data: 'repo:request-7:2' }],
  ]);
});

test('150 Issues retain every assignee row, unique count, closed state, Status and whole links', () => {
  const items = Array.from({ length: 150 }, (_, i) => item(i + 1));
  items[0]!.status = null;
  const messages = sprintMessages(board(items), iteration, config().users);
  const all = messages.map(m => m.html).join('\n');
  expect(messages.length).toBeGreaterThan(1);
  expect(all).toContain('Уникальных задач: 150');
  expect(all).toContain('Без исполнителя');
  expect(all).toContain('unknown');
  expect(all).toContain('tg://user?id=101');
  expect(all).toContain('без статуса');
  expect(all).toContain('CLOSED');
  expect(all).toContain('In progress');
  expect(all).not.toContain('<b>&😀');
  for (const it of items) {
    const links = all.match(new RegExp(`href="${it.issue.ref.url}"`, 'g')) ?? [];
    expect(links).toHaveLength(it.issue.assignees.length || 1);
  }
  for (const { html } of messages) {
    expect(html.length).toBeLessThanOrEqual(4096);
    expect((html.match(/<a /g) ?? []).length).toBe((html.match(/<\/a>/g) ?? []).length);
    expect(html).toContain('Sprint 8');
  }
});

test('personal filter is exact ignoring case and excludes archived/other Sprint', () => {
  const matching = item(1); matching.issue.assignees = ['OCTO'];
  const prefix = item(2); prefix.issue.assignees = ['octocat'];
  const html = sprintMessages(board([prefix, item(3, { archived: true }), item(4, { sprintId: 'other' }), matching]), iteration, config().users, 'octo').map(m => m.html).join('');
  expect(html).toContain('backend#1');
  for (const n of [2, 3, 4]) expect(html).not.toContain(`backend#${n}`);
  expect(html).toContain('Уникальных задач: 1');
  expect(sprintMessages(board([]), iteration, config().users)[0]!.html).toContain('задач нет');
});

test('sorts by login then repository and issue number', () => {
  const a = item(10), b = item(2), c = item(1);
  a.issue.assignees = ['zeta']; b.issue.assignees = ['alpha']; c.issue.assignees = ['alpha'];
  const html = sprintMessages(board([a, b, c]), iteration, []).map(m => m.html).join('');
  expect(html.indexOf('alpha')).toBeLessThan(html.indexOf('zeta'));
  expect(html.indexOf('backend#1')).toBeLessThan(html.indexOf('backend#2'));
});

test('splits a single oversized row by code point without losing text or links', () => {
  const row = item(1); row.issue.assignees = []; row.issue.title = '<&😀'.repeat(2000);
  const messages = sprintMessages(board([row]), iteration, []);
  const titles = messages.flatMap(m => [...m.html.matchAll(/<\/a> · (.*) · In progress · CLOSED/g)].map(match => match[1])).join('');
  expect(titles).toBe('&lt;&amp;😀'.repeat(2000));
  for (const { html } of messages) {
    expect(html.length).toBeLessThanOrEqual(4096);
    expect(html).toContain('Без исполнителя');
    expect(html).toContain(`<a href="${row.issue.ref.url}">backend#1</a>`);
    expect(html).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  }
});

test('help renders only the nine approved command lines without buttons or links', () => {
  expect(messages).toHaveProperty('helpMessage');
  const outgoing = messages.helpMessage();
  expect(outgoing).toEqual({ html: `<code>/help</code> — список команд.
<code>/issue</code> — создать задачу в Backlog.
<code>/close</code> — закрыть задачу.
<code>/assign @username</code> — добавить исполнителя.
<code>/assignme</code> — назначить себя.
<code>/unassign @username</code> — снять исполнителя.
<code>/tosprint</code> — перенести задачу в текущий спринт.
<code>/sprint</code> — показать спринт команды.
<code>/sprint @username</code> — показать задачи человека в текущем спринте.` });
  expect(outgoing.html.length).toBeLessThan(4096);
});
