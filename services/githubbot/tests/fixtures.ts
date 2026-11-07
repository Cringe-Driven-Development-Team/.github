import type { BotIdentity, Config } from '../src/config';
import type { Github, Issue } from '../src/github';
import type { Board, Projects, ProjectItem } from '../src/projects';

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

export function apiDoubles() {
  const issues = new Map<string, Issue>();
  const createCalls: { repo: string; title: string; body: string }[] = [];
  const mutations: string[] = [], initializedIssues: Issue[] = [];
  const board: Board = { id: 'P1', sprintFieldId: 'SPRINT', statusFieldId: 'STATUS', backlogOptionId: 'BACKLOG',
    iterations: [{ id: 'S1', title: 'Sprint 1', startDate: '2026-11-01', duration: 14 }], items: [] };
  const key = (ref: Issue['ref']) => `${ref.repo}/${ref.number}`;
  const seed = (repo = 'backend', number = 1): Issue => {
    const issue: Issue = { ref: { repo, number, url: `https://github.com/Cringe-Driven-Development-Team/${repo}/issues/${number}` },
      nodeId: `I_${repo}_${number}`, title: 'Task', state: 'OPEN', assignees: [] };
    issues.set(key(issue.ref), issue);
    return issue;
  };
  const read = (ref: Issue['ref']): Issue => {
    const issue = issues.get(key(ref));
    if (!issue) throw new Error('Unknown fake issue');
    return structuredClone(issue);
  };
  const change = (ref: Issue['ref'], mutate: (issue: Issue) => void): Issue => {
    const issue = read(ref); mutate(issue); issues.set(key(ref), issue); return structuredClone(issue);
  };
  const github: Github = {
    getIssue: async ref => read(ref),
    createIssue: async (repo, title, body) => {
      createCalls.push({ repo, title, body });
      const issue = seed(repo, createCalls.length); issue.title = title; return structuredClone(issue);
    },
    canAssign: async () => true,
    closeIssue: async ref => { mutations.push('close'); return change(ref, issue => { issue.state = 'CLOSED'; }); },
    addAssignee: async (ref, login) => { mutations.push(`assign:${login}`); return change(ref, issue => { issue.assignees.push(login); }); },
    removeAssignee: async (ref, login) => { mutations.push(`unassign:${login}`); return change(ref, issue => { issue.assignees = issue.assignees.filter(a => a !== login); }); },
  };
  const itemFor = (issue: Issue): ProjectItem => {
    let item = board.items.find(item => item.issue.nodeId === issue.nodeId);
    if (!item) { item = { id: `P_${issue.nodeId}`, issue, status: null, sprintId: null, archived: false }; board.items.push(item); }
    return item;
  };
  const projects: Projects = {
    readBoard: async () => structuredClone(board),
    initializeIssue: async issue => {
      initializedIssues.push(issue); const item = itemFor(issue); item.status = 'Backlog'; item.sprintId = null; return structuredClone(item);
    },
    toCurrentSprint: async issue => {
      const item = itemFor(issue);
      if (item.sprintId !== 'S1') { mutations.push('tosprint'); item.sprintId = 'S1'; }
      return { item: structuredClone(item), iteration: board.iterations[0]!, statusChangedExternally: false };
    },
  };
  return { github, projects, issues, board, seed, createCalls, initializedIssues, mutations };
}
