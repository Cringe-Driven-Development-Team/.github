import { expect, test } from 'bun:test';
import { parseCreatedBranchNotice } from '../src/apidog-branch';
import { createProjector } from '../src/worker';
import type { Delivery } from '../src/store';
import type { GithubApi } from '../src/github-api';
import type { ApidogApi } from '../src/apidog-api';

const settings = { projectId: 1382426, targetBranchId: 1388508, projectName: '2026_2_Cringe_Driven_Development', contractUrl: 'https://vb78fyael1.apidog.io/', reviewers: [{ name: 'Reviewer One', telegramId: '333' }, { name: 'Reviewer Two', telegramId: '444' }], peopleMap: {} };
const notice = { event: 'BRANCH_CREATED', title: 'Create Sprint Branch', content: 'Create Sprint Branch\nTeam: Personal Team\nProject: 2026_2_Cringe_Driven_Development\nSprintBranch: delete-security-scheme-folder\nCreator: yaroslav7689\nCreated at: 2026-10-26 13:30:32' };
function delivery(body: Record<string, unknown> = notice): Delivery {
  return { source: 'apidog', event: String(body.event), raw: new TextEncoder().encode(JSON.stringify(body)) } as Delivery;
}
function projector(api: ApidogApi) {
  return createProjector({} as GithubApi, { githubTopic: 26, reviewTopic: 1513, userMap: {}, apidogTopic: 88 }, { api, config: settings });
}

test('raw branch and API webhooks project no cards and never request enrichment', async () => {
  let calls = 0;
  const api = { listMergeRequests: async () => [], findMergedRequest: async () => { calls++; return undefined; }, findCreatedBranch: async () => { calls++; return { id: 1413937 }; } } as ApidogApi;
  for (const event of ['BRANCH_CREATED', 'BRANCH_MERGED', 'API_UPDATED', 'MR_OPENED']) expect(await projector(api)(delivery({ ...notice, event }))).toEqual([]);
  expect(calls).toBe(0);
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
    expect(await projector(api)(delivery({ ...notice, content }))).toEqual([]);
  }
  expect(calls).toHaveLength(0);
});
