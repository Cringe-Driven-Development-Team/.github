import { expect, test } from 'bun:test';
import { parseMergeNotice, formatApidogMerge } from '../src/apidog-merge';
import { formatApidog } from '../src/apidog';
import type { Delivery } from '../src/store';
const config = { projectId: 1382426, targetBranchId: 1388508, projectName: 'Example', contractUrl: 'https://vb78fyael1.apidog.io/', reviewers: [{ name: 'Reviewer One', telegramId: '333' }, { name: 'Reviewer Two', telegramId: '444' }], peopleMap: { '1': { name: '<Alice>', telegramId: '111' }, '2': { name: 'Bob', telegramId: '222' } } };
const payload = { event: 'BRANCH_MERGED', title: 'Merge', content: 'Merge Sprint Branch: feature  \nProject: Example \nUpdated at: 2026-10-26 10:28:47  ' };
const delivery = (body = payload): Delivery => ({ source: 'apidog', event: body.event, raw: new TextEncoder().encode(JSON.stringify(body)) }) as Delivery;
const mr = { id: 39834, sourceBranchId: 5, targetBranchId: 1388508, createdById: 1, closedById: 2, closedAt: '2026-10-26T10:28:47Z', status: 'MERGED' as const };
const render = (body = payload, result: typeof mr | undefined = mr) => formatApidogMerge(delivery(body), formatApidog(delivery(body), { apidogTopic: 88 })[0]!, { findMergedRequest: async input => { expect(input.sourceBranchName).toBe('feature'); return result; } }, config);
test('parses anchored fields and UTC seconds', () => {
  expect(parseMergeNotice(payload, 'Example')).toEqual({ sourceBranchName: 'feature', mergedAtIso: '2026-10-26T10:28:47.000Z' });
  for (const content of [payload.content.replace('Project: Example', 'Project: Other'), payload.content.replace('Project:', 'xProject:'), payload.content.replace('2026-10-26', '2026-02-30'), payload.content.replace('Updated at:', 'missing:'), payload.content + '\nProject: Example', payload.content.replace('10:28:47', '25:28:47')]) expect(parseMergeNotice({ ...payload, content }, 'Example')).toBeUndefined();
});
test('renders escaped role mentions and exact MR/contract buttons', async () => {
  const card = await render();
  expect(card.html).toContain('Создатель MR: <a href="tg://user?id=111">&lt;Alice&gt;</a>');
  expect(card.html).toContain('Слил MR: <a href="tg://user?id=222">Bob</a>');
  expect(card.button).toEqual({ text: 'Открыть MR', url: 'https://app.apidog.com/project/1382426/branch/1388508/merge-request/39834' });
  expect(card.secondaryButton).toEqual({ text: 'Контракт API', url: config.contractUrl });
});
test('unknown identity is readable and same person is pinged once', async () => {
  expect((await render(payload, { ...mr, closedById: 99 })).html).toContain('Слил MR: Apidog user 99');
  expect((await render(payload, { ...mr, closedById: 1 })).html.match(/tg:\/\/user/g)).toHaveLength(1);
});
test('missing/ambiguous result and client failure preserve contract fallback', async () => {
  const base = formatApidog(delivery(), { apidogTopic: 88 })[0]!;
  for (const api of [{ findMergedRequest: async () => undefined }, { findMergedRequest: async () => { throw new Error('private'); } }]) {
    const card = await formatApidogMerge(delivery(), base, api, config);
    expect(card.html).toBe(base.html); expect(card.button?.url).toBe(config.contractUrl); expect(card.secondaryButton).toBeUndefined();
  }
});
test('unrelated events skip lookup; long escaped summary retains both roles within limit', async () => {
  const body = { ...payload, event: 'other' }; const base = formatApidog(delivery(body), { apidogTopic: 88 })[0]!;
  expect(await formatApidogMerge(delivery(body), base, { findMergedRequest: async () => { throw new Error('unexpected'); } }, config)).toEqual(base);
  const card = await render({ ...payload, title: '<'.repeat(300), content: payload.content + '\n' + '<'.repeat(3000) });
  expect(card.html.length).toBeLessThanOrEqual(4095); expect(card.html).toContain('Слил MR:');
});
