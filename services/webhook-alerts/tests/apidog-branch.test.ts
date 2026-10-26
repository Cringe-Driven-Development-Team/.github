import { expect, spyOn, test } from 'bun:test';
import { parseCreatedBranchNotice } from '../src/apidog-branch';
import { createProjector } from '../src/worker';
import type { Delivery } from '../src/store';
import type { GithubApi } from '../src/github-api';
import type { ApidogApi } from '../src/apidog-api';

const settings = { projectId: 1382426, targetBranchId: 1388508, projectName: '2026_2_Cringe_Driven_Development', contractUrl: 'https://vb78fyael1.apidog.io/', peopleMap: {} };
const notice = { event: 'BRANCH_CREATED', title: 'Create Sprint Branch', content: 'Create Sprint Branch\nTeam: Personal Team\nProject: 2026_2_Cringe_Driven_Development\nSprintBranch: delete-security-scheme-folder\nCreator: yaroslav7689\nCreated at: 2026-10-26 13:30:32' };
function delivery(body: Record<string, unknown> = notice): Delivery {
  return { source: 'apidog', event: String(body.event), raw: new TextEncoder().encode(JSON.stringify(body)) } as Delivery;
}
function projector(api: ApidogApi) {
  return createProjector({} as GithubApi, { githubTopic: 26, reviewTopic: 1513, userMap: {}, apidogTopic: 88 }, { api, config: settings });
}

test('BRANCH_CREATED links the exact created sprint branch', async () => {
  const calls: unknown[] = [];
  const api = {
    listMergeRequests: async () => [], findMergedRequest: async () => undefined,
    findCreatedBranch: async (input: unknown) => { calls.push(input); return { id: 1413937 }; },
  } as ApidogApi;
  const [card] = await projector(api)(delivery());
  expect(calls).toEqual([{ projectId: 1382426, branchName: 'delete-security-scheme-folder', createdAtIso: '2026-10-26T13:30:32.000Z' }]);
  expect(card?.button).toEqual({ text: 'Открыть ветку', url: 'https://app.apidog.com/project/1382426/branch/1413937' });
  expect(card?.topic).toBe(88);
});

test('invalid branch ID never becomes a Telegram URL', async () => {
  const api = { listMergeRequests: async () => [], findMergedRequest: async () => undefined, findCreatedBranch: async () => ({ id: -1 }) } as ApidogApi;
  const [card] = await projector(api)(delivery());
  expect(card?.button).toBeUndefined();
});

test('creation notice requires unique anchored fields and a valid UTC second', async () => {
  expect(parseCreatedBranchNotice(notice, settings.projectName)).toEqual({ branchName: 'delete-security-scheme-folder', createdAtIso: '2026-10-26T13:30:32.000Z' });
  const invalid = [
    notice.content.replace('Project: 2026_2_Cringe_Driven_Development', 'Project: Another'),
    notice.content.replace('SprintBranch:', 'xSprintBranch:'),
    notice.content.replace('2026-10-26', '2026-02-30'),
    notice.content.replace('13:30:32', '25:30:32'),
    notice.content + '\nSprintBranch: another',
    notice.content + '\nCreated at: 2026-10-26 13:30:32',
  ];
  const calls: unknown[] = [];
  const api = { listMergeRequests: async () => [], findMergedRequest: async () => undefined, findCreatedBranch: async (input: unknown) => { calls.push(input); return { id: 1413937 }; } } as ApidogApi;
  for (const content of invalid) {
    expect(parseCreatedBranchNotice({ ...notice, content }, settings.projectName)).toBeUndefined();
    expect((await projector(api)(delivery({ ...notice, content })))[0]?.button).toBeUndefined();
  }
  expect(calls).toHaveLength(0);
});

test('lookup absence and failure preserve any safe existing app link without leaking errors', async () => {
  const body = { ...notice, appLink: 'https://app.apidog.com/project/1382426' };
  const missing = { listMergeRequests: async () => [], findMergedRequest: async () => undefined, findCreatedBranch: async () => undefined } as ApidogApi;
  expect((await projector(missing)(delivery(body)))[0]?.button?.url).toBe(body.appLink);
  const logged: string[] = [];
  const log = spyOn(console, 'error').mockImplementation(value => { logged.push(String(value)); });
  try {
    const failing = { listMergeRequests: async () => [], findMergedRequest: async () => undefined, findCreatedBranch: async () => { throw new Error('private-token'); } } as ApidogApi;
    expect((await projector(failing)(delivery(body)))[0]?.button?.url).toBe(body.appLink);
  } finally { log.mockRestore(); }
  expect(logged).toEqual(['{"errorCode":"apidog_branch_lookup_failed"}']);
  expect(logged.join()).not.toContain('private-token');
});
