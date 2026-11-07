import { describe, expect, spyOn, test } from 'bun:test';
import { ApiError, createGithub } from '../src/github';
import type { IssueRef } from '../src/commands';
import { config } from './fixtures';

const root = 'https://api.github.com/repos/Cringe-Driven-Development-Team/backend';
const ref: IssueRef = { repo: 'backend', number: 7, url: 'https://github.com/Cringe-Driven-Development-Team/backend/issues/7' };
function issue(assignees = ['existing'], state = 'open') {
  return { number: 7, node_id: 'I_7', title: 'Backend. X', state, html_url: ref.url, assignees: assignees.map(login => ({ login })) };
}
function fake(...responses: (Response | Error)[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const options: RequestInit[] = [];
  const fetcher = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    options.push(init ?? {});
    const next = responses.shift();
    if (!next) throw new Error('Unexpected request');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { api: createGithub(config(), fetcher), calls, options };
}

describe('GitHub Issues REST adapter', () => {
  test('reads issue and builds authenticated API request with a 15 second timeout', async () => {
    const timeout = spyOn(AbortSignal, 'timeout');
    try {
      const { api, calls, options } = fake(Response.json(issue()));
      expect(await api.getIssue(ref)).toEqual({ ref, nodeId: 'I_7', title: 'Backend. X', state: 'OPEN', assignees: ['existing'] });
      expect(calls).toEqual([{ url: `${root}/issues/7`, method: 'GET', body: undefined }]);
      expect(new Headers(options[0]?.headers).get('authorization')).toBe('Bearer fake-github-token');
      expect(options[0]?.redirect).toBe('manual');
      expect(options[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(timeout).toHaveBeenCalledWith(15_000);
    } finally { timeout.mockRestore(); }
  });

  test('creates with title and body only and returns known identity immediately', async () => {
    const { api, calls } = fake(Response.json(issue([]), { status: 201 }));
    expect(await api.createIssue('backend', 'Backend. X', 'details')).toEqual({ ref, nodeId: 'I_7', title: 'Backend. X', state: 'OPEN', assignees: [] });
    expect(calls).toEqual([{ url: `${root}/issues`, method: 'POST', body: { title: 'Backend. X', body: 'details' } }]);
  });

  test('rejects pull requests before changing them', async () => {
    const { api, calls } = fake(Response.json({ ...issue(), pull_request: { url: 'https://api.github.com/pulls/7' } }));
    await expect(api.closeIssue(ref)).rejects.toMatchObject({ provider: 'github', kind: 'rejected' });
    expect(calls).toHaveLength(1);
  });

  test.each([[204, true], [404, false]] as const)('canAssign maps status %s to %s', async (status, expected) => {
    const { api, calls } = fake(new Response(null, { status }));
    expect(await api.canAssign('backend', 'octo')).toBe(expected);
    expect(calls[0]?.url).toBe(`${root}/assignees/octo`);
  });

  test('canAssign does not swallow permission failure', async () => {
    const { api } = fake(new Response('private token content', { status: 403 }));
    await expect(api.canAssign('backend', 'octo')).rejects.toMatchObject({ provider: 'github', kind: 'rejected' });
  });

  test('adds only the requested assignee and reads back the preserved assignees', async () => {
    const { api, calls } = fake(Response.json(issue()), new Response(null, { status: 204 }), Response.json(issue(['existing', 'octo'])), Response.json(issue(['existing', 'octo'])));
    const result = await api.addAssignee(ref, 'octo');
    expect(calls.filter(x => x.method === 'POST').map(x => x.body))
      .toEqual([{ assignees: ['octo'] }]);
    expect(result.assignees).toEqual(['existing', 'octo']);
    expect(calls.map(x => [x.method, x.url])).toEqual([
      ['GET', `${root}/issues/7`], ['GET', `${root}/assignees/octo`],
      ['POST', `${root}/issues/7/assignees`], ['GET', `${root}/issues/7`],
    ]);
  });

  test('refuses assignment unavailable in the repository without writing', async () => {
    const { api, calls } = fake(Response.json(issue()), new Response(null, { status: 404 }));
    await expect(api.addAssignee(ref, 'octo')).rejects.toMatchObject({ kind: 'rejected' });
    expect(calls.every(x => x.method === 'GET')).toBe(true);
  });

  test('removes only the requested assignee and reads back the others', async () => {
    const { api, calls } = fake(Response.json(issue(['existing', 'octo'])), Response.json(issue()), Response.json(issue()));
    expect((await api.removeAssignee(ref, 'octo')).assignees).toEqual(['existing']);
    expect(calls.filter(x => x.method === 'DELETE')).toEqual([{ url: `${root}/issues/7/assignees`, method: 'DELETE', body: { assignees: ['octo'] } }]);
    expect(calls.at(-1)?.method).toBe('GET');
  });

  test('closes as completed and returns the readback issue', async () => {
    const { api, calls } = fake(Response.json(issue()), Response.json(issue(['existing'], 'closed')), Response.json({ ...issue(['existing'], 'closed'), title: 'Current title' }));
    expect(await api.closeIssue(ref)).toMatchObject({ title: 'Current title', state: 'CLOSED' });
    expect(calls.filter(x => x.method === 'PATCH')).toEqual([{ url: `${root}/issues/7`, method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } }]);
    expect(calls.at(-1)?.method).toBe('GET');
  });

  test('repeated add, absent removal and closed issue perform no writes', async () => {
    const { api, calls } = fake(Response.json(issue(['existing', 'OcTo'])), Response.json(issue()), Response.json(issue(['existing'], 'closed')));
    expect((await api.addAssignee(ref, 'octo')).assignees).toEqual(['existing', 'OcTo']);
    expect((await api.removeAssignee(ref, 'octo')).assignees).toEqual(['existing']);
    expect((await api.closeIssue(ref)).state).toBe('CLOSED');
    expect(calls.map(x => x.method)).toEqual(['GET', 'GET', 'GET']);
  });

  test.each(['addAssignee', 'removeAssignee', 'closeIssue'] as const)('%s does not report success when readback differs', async operation => {
    const before = operation === 'removeAssignee' ? ['existing', 'octo'] : ['existing'];
    const { api } = fake(Response.json(issue(before)), ...(operation === 'addAssignee' ? [new Response(null, { status: 204 })] : []), Response.json(issue(before)), Response.json(issue(before)));
    await expect(api[operation](ref, 'octo')).rejects.toBeInstanceOf(ApiError);
  });

  test('transport failure creating an issue is uncertain with one attempt', async () => {
    const { api, calls } = fake(new Error('socket failure fake-github-token'));
    await expect(api.createIssue('backend', 'Backend. X', '')).rejects.toMatchObject({ provider: 'github', kind: 'uncertain' });
    expect(calls).toHaveLength(1);
  });

  test.each([500, 502, 503])('HTTP %s creating an issue is uncertain and never retried', async status => {
    const { api, calls } = fake(new Response('failure', { status }));
    await expect(api.createIssue('backend', 'Backend. X', '')).rejects.toMatchObject({ kind: 'uncertain' });
    expect(calls).toHaveLength(1);
  });

  test('validation failure creating an issue is rejected', async () => {
    const { api, calls } = fake(new Response('failure', { status: 422 }));
    await expect(api.createIssue('backend', 'Backend. X', '')).rejects.toMatchObject({ kind: 'rejected' });
    expect(calls).toHaveLength(1);
  });

  const rateLimits: { status: number; headers: Record<string, string>; delay: number }[] = [
    { status: 429, headers: { 'retry-after': '3' }, delay: 3000 },
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) }, delay: 60000 },
    { status: 403, headers: { 'retry-after': '5' }, delay: 5000 },
    { status: 429, headers: {}, delay: 60000 },
    { status: 429, headers: { 'retry-after': new Date(Date.now() + 60000).toUTCString() }, delay: 60000 },
  ];
  test.each(rateLimits)('rate limit $status provides a retry delay without retrying', async ({ status, headers, delay }) => {
    const { api, calls } = fake(new Response(null, { status, headers }));
    try { await api.getIssue(ref); throw new Error('Expected rate limit'); }
    catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ provider: 'github', kind: 'retryable' });
      expect((error as ApiError).retryAfterMs).toBeGreaterThan(delay - 1500);
      expect((error as ApiError).retryAfterMs).toBeLessThanOrEqual(delay);
    }
    expect(calls).toHaveLength(1);
  });

  test('secondary rate limit without headers provides a delay', async () => {
    const { api } = fake(Response.json({ message: 'You have exceeded a secondary rate limit.' }, { status: 403 }));
    await expect(api.getIssue(ref)).rejects.toMatchObject({ kind: 'retryable', retryAfterMs: 60000 });
  });

  test('GET transport and 5xx failures are retryable and hide upstream content', async () => {
    const { api, calls } = fake(new Error('fake-github-token'), new Response('fake-github-token', { status: 500 }));
    for (let i = 0; i < 2; i++) {
      try { await api.getIssue(ref); throw new Error('Expected failure'); }
      catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toMatchObject({ kind: 'retryable' });
        expect(String(error)).not.toContain('fake-github-token');
      }
    }
    expect(calls).toHaveLength(2);
  });

  test('redirect responses never forward credentials to another URL', async () => {
    const { api, calls, options } = fake(new Response(null, { status: 307, headers: { location: 'https://evil.invalid/steal' } }));
    await expect(api.getIssue(ref)).rejects.toMatchObject({ kind: 'rejected' });
    expect(calls).toHaveLength(1);
    expect(options[0]?.redirect).toBe('manual');
  });

  test('request target uses validated repo and number and ignores ref URL', async () => {
    const { api, calls } = fake(Response.json(issue()));
    await api.getIssue({ ...ref, url: 'https://evil.invalid/steal' });
    expect(calls[0]?.url).toBe(`${root}/issues/7`);
    await expect(api.getIssue({ ...ref, repo: '../frontend' })).rejects.toMatchObject({ kind: 'rejected' });
    await expect(api.getIssue({ ...ref, number: 0 })).rejects.toMatchObject({ kind: 'rejected' });
    await expect(api.canAssign('backend', '../octo')).rejects.toMatchObject({ kind: 'rejected' });
    await expect(api.createIssue('external', 'Backend. X', '')).rejects.toMatchObject({ kind: 'rejected' });
    await expect(api.createIssue('backend', '  ', '')).rejects.toMatchObject({ kind: 'rejected' });
    expect(calls).toHaveLength(1);
  });

  test.each([
    { ...issue(), state: 'unknown' }, { ...issue(), state: ['open'] }, { ...issue(), number: 8 },
    { ...issue(), node_id: null }, { ...issue(), assignees: [{}] },
  ])('rejects malformed or mismatched issue responses', async response => {
    const { api } = fake(Response.json(response));
    await expect(api.getIssue(ref)).rejects.toMatchObject({ kind: 'retryable' });
  });

  test('malformed successful create remains uncertain without another request', async () => {
    const { api, calls } = fake(new Response('{', { status: 201 }));
    await expect(api.createIssue('backend', 'Backend. X', '')).rejects.toMatchObject({ kind: 'uncertain' });
    expect(calls).toHaveLength(1);
  });

  test.each([{ ...issue(), node_id: null }, { ...issue(), pull_request: {} }])('invalid created issue remains uncertain', async response => {
    const { api, calls } = fake(Response.json(response, { status: 201 }));
    await expect(api.createIssue('backend', 'Backend. X', '')).rejects.toMatchObject({ kind: 'uncertain' });
    expect(calls).toHaveLength(1);
  });
});
