import { expect, test } from 'bun:test';
import { ApidogApiError, createApidogApi } from '../src/apidog-api';
const token = 'secret-test-token';
const input = { projectId: 1382426, targetBranchId: 1388508, sourceBranchName: 'ai/20261025-from-main-api41-review', mergedAtIso: '2026-10-26T10:28:47Z' };
const mr = { id: 39834, sourceBranchId: 1413082, targetBranchId: 1388508, createdById: 1066826, closedById: 1067537, closedAt: '2026-10-26T10:28:47.000Z', status: 'MERGED' as const };
const branches = { success: true, data: [{ id: 1413082, name: input.sourceBranchName }] };
const list = (rows: unknown[] = [mr], nextPage: number | null = null) => ({ success: true, data: rows, meta: { nextPage } });
function api(responses: unknown[]) {
  const urls: URL[] = [];
  const client = createApidogApi({ token, fetch: (async (url, init) => {
    const parsed = new URL(String(url)); urls.push(parsed);
    expect(parsed.origin).toBe('https://api.apidog.com');
    expect(parsed.href).not.toContain(token);
    expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${token}`);
    expect(headers.get('X-Apidog-Api-Version')).toBe('2026-05-28');
    return Response.json(responses.shift());
  }) as typeof fetch });
  return { client, urls };
}
async function errorCode(run: Promise<unknown>, code: ApidogApiError['code']) {
  try { await run; throw new Error('expected failure'); } catch (error) {
    expect(error).toBeInstanceOf(ApidogApiError); expect((error as ApidogApiError).code).toBe(code);
    expect(String(error)).not.toContain(token); expect(String(error)).not.toContain('private response');
    expect(JSON.stringify(error)).not.toContain(token);
  }
}
test('verified detail and authenticated filtered GET requests', async () => {
  const { client, urls } = api([branches, list(), { success: true, data: mr }]);
  expect(await client.findMergedRequest(input)).toEqual(mr);
  expect(urls.map(u => u.pathname)).toEqual(['/api/v1/projects/1382426/sprint-branches', '/api/v1/projects/1382426/sprint-branches/1388508/merge-requests', '/api/v1/projects/1382426/sprint-branches/1388508/merge-requests/39834']);
  expect(Object.fromEntries(urls[1]!.searchParams)).toEqual({ sourceBranchId: '1413082', status: 'MERGED', page: '1', perPage: '100' });
});
test('created branch lookup selects the exact project, name, type and creation second', async () => {
  const { client, urls } = api([{ success: true, data: [
    { id: 1413937, name: 'delete-security-scheme-folder', projectId: 1382426, type: 'SPRINT', isMain: false, createdAt: '2026-10-26T13:30:32.000Z' },
    { id: 99, name: 'delete-security-scheme-folder', projectId: 1382426, type: 'SPRINT', isMain: false, createdAt: '2026-10-26T13:30:31.000Z' },
  ] }]);
  expect(typeof client.findCreatedBranch).toBe('function');
  expect(await client.findCreatedBranch({ projectId: 1382426, branchName: 'delete-security-scheme-folder', createdAtIso: '2026-10-26T13:30:32.000Z' })).toEqual({ id: 1413937 });
  expect(urls.map(url => url.pathname)).toEqual(['/api/v1/projects/1382426/sprint-branches']);
});
test('created branch lookup omits ambiguous or unrelated rows', async () => {
  const input = { projectId: 1382426, branchName: 'delete-security-scheme-folder', createdAtIso: '2026-10-26T13:30:32.000Z' };
  const row = { id: 1413937, name: input.branchName, projectId: input.projectId, type: 'SPRINT', isMain: false, createdAt: input.createdAtIso };
  for (const change of [
    { name: 'another' }, { projectId: 1 }, { type: 'GENERAL' }, { isMain: true }, { createdAt: '2026-10-26T13:30:33.000Z' }, { id: -1 },
  ]) expect(await api([{ success: true, data: [{ ...row, ...change }] }]).client.findCreatedBranch(input)).toBeUndefined();
  expect(await api([{ success: true, data: [row, { ...row, id: 1413938 }] }]).client.findCreatedBranch(input)).toBeUndefined();
});
test('created branch lookup classifies API failure without leaking response data', async () => {
  const input = { projectId: 1382426, branchName: 'delete-security-scheme-folder', createdAtIso: '2026-10-26T13:30:32.000Z' };
  const fetcher = (async () => new Response(`private response ${token}`, { status: 503 })) as unknown as typeof fetch;
  await errorCode(createApidogApi({ token, fetch: fetcher }).findCreatedBranch(input), 'http_503');
});
test('checks local IDs despite ignored filters and follows nextPage', async () => {
  const { client, urls } = api([branches, list([{ ...mr, sourceBranchId: 12 }], 2), list(), { success: true, data: mr }]);
  expect(await client.findMergedRequest(input)).toEqual(mr); expect(urls[2]?.searchParams.get('page')).toBe('2');
});
test('absent or ambiguous branch gives no match', async () => {
  for (const data of [[], [...branches.data, ...branches.data]]) expect(await api([{ success: true, data }]).client.findMergedRequest(input)).toBeUndefined();
});
test('ambiguous MR gives no match', async () => {
  expect(await api([branches, list([mr, { ...mr, id: 39835 }]), { success: true, data: mr }, { success: true, data: { ...mr, id: 39835 } }]).client.findMergedRequest(input)).toBeUndefined();
});
test('checks detail IDs status and timestamp to the second', async () => {
  for (const change of [{ closedAt: '2026-10-26T10:28:48Z' }, { sourceBranchId: 1 }, { targetBranchId: 2 }, { status: 'OPEN' }, { id: 9 }]) expect(await api([branches, list(), { success: true, data: { ...mr, ...change } }]).client.findMergedRequest(input)).toBeUndefined();
  expect(await api([branches, list(), { success: true, data: { ...mr, closedAt: '2026-10-26T10:28:47.999Z' } }]).client.findMergedRequest(input)).toEqual({ ...mr, closedAt: '2026-10-26T10:28:47.999Z' });
});
test('malformed envelopes and detail fields are classified', async () => {
  for (const body of [{}, { success: false, data: [] }, { success: true, data: {} }]) await errorCode(api([body]).client.findMergedRequest(input), 'invalid_response');
  await errorCode(api([branches, list(), { success: true, data: { ...mr, createdById: '1066826' } }]).client.findMergedRequest(input), 'invalid_response');
});
test('pagination cycles are bounded', async () => { await errorCode(api([branches, list([], 1)]).client.findMergedRequest(input), 'pagination_limit'); });
test('HTTP network and invalid JSON errors exclude secrets and response bodies', async () => {
  for (const [fetcher, code] of [
    [async () => new Response(`private response ${token}`, { status: 503 }), 'http_503'],
    [async () => { throw new Error(`private response ${token}`); }, 'network'],
    [async () => new Response(`private response ${token}`), 'invalid_response'],
  ] as const) await errorCode(createApidogApi({ token, fetch: fetcher as unknown as typeof fetch }).findMergedRequest(input), code);
});
test('overall timeout works even when transport ignores abort', async () => {
  await errorCode(createApidogApi({ token, timeoutMs: 5, fetch: (() => new Promise(() => {})) as unknown as typeof fetch }).findMergedRequest(input), 'timeout');
});

test('bounds endless increasing pages', async () => {
  await errorCode(api([branches, ...Array.from({ length: 20 }, (_, i) => list([], i + 2))]).client.findMergedRequest(input), 'pagination_limit');
});
test('timeout includes body parsing and entire lookup', async () => {
  const fetcher = (async () => ({ ok: true, json: () => new Promise(() => {}) })) as unknown as typeof fetch;
  await errorCode(createApidogApi({ token, timeoutMs: 5, fetch: fetcher }).findMergedRequest(input), 'timeout');
});
