import { describe, expect, test } from 'bun:test';
import issueFixture from './fixtures/github/issues-opened.json';
import prFixture from './fixtures/github/pr-opened.json';
import pushFixture from './fixtures/github/push.json';
import commentFixture from './fixtures/github/comment-created.json';
import reviewFixture from './fixtures/github/review-submitted.json';
import { formatGithub } from '../src/github';
import { createGithubApi, GithubApiError, type GithubApi } from '../src/github-api';
import { escapeHtml, mention, quoteMarkdown } from '../src/format';
import { createGithubProjector } from '../src/worker';
import type { Delivery } from '../src/store';
const now = Date.parse('2026-10-24T12:00:00Z');
const config = { userMap: { author: '111', reviewer: '222' } };
function delivery(event: string, payload: unknown): Delivery {
  return { id: 1, source: 'github', deliveryId: 'test', event, raw: Buffer.from(JSON.stringify(payload)), bodyHash: 'hash', receivedAt: now, prepared: false, leaseUntil: null };
}
function api(overrides: Partial<GithubApi> = {}): GithubApi {
  const missing = async (): Promise<never> => { throw new Error('unexpected API access: secret'); };
  return { compare: missing, reviews: missing, reviewComments: missing, pullRequest: missing, recentClosedPullRequests: missing, ...overrides };
}
function issue(action = 'opened') {
  return { ...issueFixture, action, sender: { login: 'author' }, issue: { ...issueFixture.issue,
    number: 5, title: 'Починить <b>вход</b>', body: '## Что сделать\nПроверить <!-- скрыто --> & записать',
    html_url: 'https://github.com/o/r/issues/5?a=1&b="x"', user: { login: 'author' }, assignees: [{ login: 'reviewer' }],
    created_at: '2026-10-24T10:00:00Z', updated_at: '2026-10-24T11:00:00Z' } };
}
function pr(action = 'opened') {
  return { ...prFixture, action, requested_reviewer: { login: 'reviewer' }, pull_request: { ...prFixture.pull_request,
    number: 7, title: 'WEB-5: Вход', html_url: 'https://github.com/o/r/pull/7', draft: false,
    user: { login: 'author' }, requested_reviewers: [{ login: 'reviewer' }], created_at: '2026-10-24T10:00:00Z', head: { sha: 'bbb222' }, base: { ref: 'main' } } };
}
function push(forced = false) {
  return { ...pushFixture, ref: 'refs/heads/task<1>', forced, deleted: false, before: 'aaa111', after: 'bbb222', compare: 'https://github.com/o/r/compare/aaa111...bbb222', repository: { full_name: 'frontend-park-mail-ru/example', default_branch: 'main', pushed_at: now / 1000 }, commits: [{ id: 'abcdef01234', message: 'feat: первое\nтело', distinct: true }, { id: 'other', message: 'из main', distinct: false }] };
}
function comment(isPr = false, author = 'reviewer') {
  return { ...commentFixture, action: 'created', issue: { ...issue().issue, ...(isPr ? { pull_request: {} } : {}) }, comment: { user: { login: author, type: 'User' }, body: 'Сделал **бакет**', html_url: 'https://github.com/o/r/issues/5#issuecomment-1' } };
}

describe('GitHub event projection', () => {
  test('issue card escapes title and URLs, mentions assignee, quotes description with fallback', async () => {
    const [m] = await formatGithub(delivery('issues', issue()), api(), config);
    expect(m?.topic).toBe(26); expect(m?.html).toContain('#5 Починить &lt;b&gt;вход&lt;/b&gt;');
    expect(m?.html).toContain('a=1&amp;b=%22x%22'); expect(m?.html).toContain('tg://user?id=222');
    expect(m?.html).toContain('<blockquote expandable><b>Что сделать</b>'); expect(m?.html).not.toContain('скрыто');
    expect(m?.fallbackHtml).not.toContain('blockquote'); expect(m?.button?.text).toBe('Открыть задачу');
  });
  test.each(['closed', 'reopened'])('issue %s omits description', async action => {
    const [m] = await formatGithub(delivery('issues', issue(action)), api(), config);
    expect(m?.button?.text).toBe('Открыть задачу'); expect(m?.html).not.toContain('blockquote');
  });
  test('edited issue filters title-only and first ten minutes', async () => {
    const p = { ...issue('edited'), changes: {} as Record<string, unknown> };
    expect(await formatGithub(delivery('issues', p), api(), config)).toEqual([]);
    p.changes = { body: { from: 'old' } }; p.issue.updated_at = '2026-10-24T10:09:59Z';
    expect(await formatGithub(delivery('issues', p), api(), config)).toEqual([]);
    p.issue.updated_at = '2026-10-24T10:10:00Z';
    expect((await formatGithub(delivery('issues', p), api(), config))[0]?.html).toContain('Описание изменено');
  });
  test('push lists distinct first-line commits with encoded branch URL', async () => {
    const [m] = await formatGithub(delivery('push', push()), api(), config);
    for (const s of ['⚒️ 1 коммит', '· frontend ·', '/tree/task%3C1%3E', '• abcdef0 feat: первое']) expect(m?.html).toContain(s);
    expect(m?.html).not.toContain('из main'); expect(m?.html).not.toContain('тело');
  });
  test.each([false, true])('organization push intake suppresses default branches, tags and invalid refs before API enrichment (forced=%s)', async forced => {
    for (const [ref, defaultBranch] of [
      ['refs/heads/main', 'main'], ['refs/heads/trunk', 'trunk'],
      ['refs/tags/v1', 'main'], ['refs/heads/', 'main'], ['', 'main'], ['main', 'main'],
    ]) {
      const p = push(forced); p.ref = ref!; p.repository.default_branch = defaultBranch!;
      const warnings: unknown[] = [];
      expect(await formatGithub(delivery('push', p), api(), { ...config, warn: w => warnings.push(w) })).toEqual([]);
      expect(warnings).toEqual([]);
    }
  });
  test('a branch named main remains eligible when the repository default is trunk', async () => {
    const p = push(); p.ref = 'refs/heads/main'; p.repository.default_branch = 'trunk';
    expect(await formatGithub(delivery('push', p), api(), config)).toHaveLength(1);
  });
  test('deleted and zero-distinct pushes are silent', async () => {
    const p = push(); p.commits[0]!.distinct = false;
    expect(await formatGithub(delivery('push', p), api(), config)).toEqual([]);
    p.deleted = true; p.forced = true;
    expect(await formatGithub(delivery('push', p), api(), config)).toEqual([]);
  });
  test('push keeps ten commit lines below 4096 even for huge escaped subjects', async () => {
    const p = push(); p.commits = Array.from({ length: 12 }, (_, i) => ({ id: `abcdef${i}`, message: '<&'.repeat(5000), distinct: true }));
    const [m] = await formatGithub(delivery('push', p), api(), config);
    expect(m!.html.length).toBeLessThan(4096); expect(m!.html.match(/^• /gm)?.length).toBe(10); expect(m!.html).toContain('…и ещё 2');
  });
  test('force push compares old/new subjects and lists only new commits', async () => {
    const [m] = await formatGithub(delivery('push', push(true)), api({ compare: async (_repo, _base, head) => ({ commits: head === 'bbb222' ? [{ sha: 'abcdef0', message: 'existing' }, { sha: '1234567', message: 'new' }] : [{ sha: 'old', message: 'existing' }] }), recentClosedPullRequests: async () => [] }), config);
    expect(m!.html).toContain('ветка переписана: 2 коммита поверх main, новых — 1'); expect(m!.html).toContain('• 1234567 new'); expect(m!.html).not.toContain('• abcdef0'); expect(m?.button?.text).toBe('Ветка целиком');
  });
  test('force reset and no-common-ancestor stay meaningful', async () => {
    const [reset] = await formatGithub(delivery('push', push(true)), api({ compare: async () => ({ commits: [] }), recentClosedPullRequests: async () => [] }), config);
    expect(reset?.html).toContain('ветка сброшена до main');
    const [unrelated] = await formatGithub(delivery('push', push(true)), api({ compare: async () => { throw new GithubApiError('no_common_ancestor'); }, recentClosedPullRequests: async () => [] }), { ...config, warn: () => {} });
    expect(unrelated?.html).toContain('нет общей истории с main');
  });
  test('API failure preserves basic force-push card with safe warning', async () => {
    const warnings: unknown[] = [];
    const [m] = await formatGithub(delivery('push', push(true)), api(), { ...config, warn: w => warnings.push(w) });
    expect(m?.html).toContain('(force-push)'); expect(warnings.length).toBeGreaterThan(0); expect(JSON.stringify(warnings)).not.toContain('secret');
  });
  test('opened PR splits author and reviewer mentions between topics', async () => {
    const messages = await formatGithub(delivery('pull_request', pr()), api(), config);
    expect(messages.map(m => m.topic)).toEqual([26, 1513]);
    expect(messages[0]?.html).toContain('tg://user?id=111'); expect(messages[0]?.html).not.toContain('tg://user?id=222');
    expect(messages[1]?.html).toContain('tg://user?id=222'); expect(messages[1]?.html).not.toContain('tg://user?id=111');
    expect(messages[1]?.button).toEqual({ text: 'Начать ревью', url: 'https://github.com/o/r/pull/7/files' });
  });
  test('draft silent, ready emits, immediate request suppressed using received time', async () => {
    const p = pr(); p.pull_request.draft = true;
    expect(await formatGithub(delivery('pull_request', p), api(), config)).toEqual([]);
    p.action = 'ready_for_review'; p.pull_request.draft = false;
    expect(await formatGithub(delivery('pull_request', p), api(), config)).toHaveLength(2);
    p.action = 'review_requested'; p.pull_request.created_at = '2026-10-24T11:59:30Z';
    expect(await formatGithub(delivery('pull_request', p), api(), config)).toEqual([]);
  });
  test('repeat review uses latest submitted review by requested reviewer', async () => {
    const [m] = await formatGithub(delivery('pull_request', pr('review_requested')), api({ reviews: async () => [{ id: 1, login: 'reviewer', state: 'CHANGES_REQUESTED', commitId: 'aaa111' }, { id: 2, login: 'other', state: 'APPROVED' }, { id: 3, login: 'reviewer', state: 'PENDING' }], compare: async () => ({ aheadBy: 3, commits: [] }) }), config);
    expect(m?.topic).toBe(1513); expect(m?.html).toContain('после твоего ревью (✋ правки): 3 коммита'); expect(m?.button?.url).toContain('/files/aaa111..bbb222');
  });
  test.each([true, false])('closed PR merged=%s has direct button', async merged => {
    const p = pr('closed'); Object.assign(p.pull_request, { merged, base: { ref: 'exp<1>' } });
    const [m] = await formatGithub(delivery('pull_request', p), api(), config);
    expect(m?.html).toContain(merged ? 'Влито в exp&lt;1&gt;' : 'закрыт без мержа'); expect(m?.button?.text).toBe('Открыть PR');
  });
  test('issue comment pings other participants with quote and comment link', async () => {
    const [m] = await formatGithub(delivery('issue_comment', comment()), api(), config);
    expect(m?.topic).toBe(26); expect(m?.html).toContain('от: reviewer · для: <a href="tg://user?id=111">author</a>');
    expect(m?.html).not.toContain('tg://user?id=222'); expect(m?.html).toContain('Сделал <b>бакет</b>'); expect(m?.button?.url).toEndWith('#issuecomment-1');
  });
  test('PR comments route to review; author response fetches reviewers only when missing', async () => {
    const [m] = await formatGithub(delivery('issue_comment', comment(true, 'author')), api({ pullRequest: async () => ({ requestedReviewers: ['reviewer'] }) }), config);
    expect(m?.topic).toBe(1513); expect(m?.html).toContain('tg://user?id=222'); expect(m?.html).not.toContain('#5 ');
    const [other] = await formatGithub(delivery('issue_comment', comment(true)), api(), config); expect(other?.html).toContain('tg://user?id=111');
  });
  test('comment API failure sends without guessed recipient', async () => {
    const warnings: unknown[] = [];
    const [m] = await formatGithub(delivery('issue_comment', comment(true, 'author')), api(), { ...config, warn: w => warnings.push(w) });
    expect(m?.html).not.toContain('для:'); expect(warnings).toHaveLength(1);
  });
  test('bot and auto comments silent; embedded marker ordinary', async () => {
    const p = comment(); p.comment.user.type = 'Bot'; expect(await formatGithub(delivery('issue_comment', p), api(), config)).toEqual([]);
    p.comment.user.type = 'User'; p.comment.body = '<!-- auto -->closed'; expect(await formatGithub(delivery('issue_comment', p), api(), config)).toEqual([]);
    p.comment.body = 'Пример <!-- auto --> внутри'; expect(await formatGithub(delivery('issue_comment', p), api(), config)).toHaveLength(1);
  });
  test('commented review waits for aggregation; approvals immediate; author ignored', async () => {
    const p = { ...reviewFixture, action: 'submitted', pull_request: pr().pull_request, review: { id: 9, user: { login: 'reviewer', type: 'User' }, state: 'commented', body: '', html_url: 'https://github.com/o/r/pull/7#pullrequestreview-9' } };
    expect(await formatGithub(delivery('pull_request_review', p), api(), config)).toEqual([]);
    p.review.state = 'approved';
    const [m] = await formatGithub(delivery('pull_request_review', p), api({ reviews: async () => [], reviewComments: async () => [] }), config);
    expect(m?.topic).toBe(1513); expect(m?.html).toContain('👍 Апрув'); expect(m?.html).toContain('tg://user?id=111');
    p.review.user.login = 'author'; expect(await formatGithub(delivery('pull_request_review', p), api(), config)).toEqual([]);
  });
  test('worker projector ignores non-GitHub and unsupported actions', async () => {
    const project = createGithubProjector(api(), config);
    expect(await project({ ...delivery('issues', issue()), source: 'apidog' })).toEqual([]);
    expect(await project(delivery('issues', issue('labeled')))).toEqual([]);
  });
});
describe('safe quote formatting', () => {
  test('preserves code, converts Markdown/images, strips HTML/comments', () => {
    const q = quoteMarkdown('## **Зачем**\n`pulumi/<id>` и <b>тег</b>\n- [x] Готово\n~~старое~~\n![скрин](https://i.io/a.png)\n```html\n<!-- keep --> **нет**\n```\n<!-- скрыто -->');
    for (const s of ['<b>Зачем</b>', '<code>pulumi/&lt;id&gt;</code>', '☑ Готово', '<s>старое</s>', '<a href="https://i.io/a.png">🖼 картинка</a>', '<pre>&lt;!-- keep --&gt; **нет**</pre>']) expect(q).toContain(s);
    expect(q).not.toContain('<b><b>'); expect(q).not.toContain('скрыто');
  });
  test('700 Unicode character cap and incomplete fences', () => {
    const q = quoteMarkdown('😀'.repeat(800)); expect([...q]).toHaveLength(700); expect(q).toEndWith('…');
    expect(quoteMarkdown('```go\n' + 'сущ'.repeat(300))).not.toContain('```'); expect(quoteMarkdown('<!-- template -->')).toBe('');
  });
  test('untrusted URL and mention cannot introduce attributes', () => {
    expect(escapeHtml('<&"')).toBe('&lt;&amp;&quot;'); expect(mention('bad<x>', { 'bad<x>': '1" onclick="evil' })).toBe('bad&lt;x&gt;');
    expect(quoteMarkdown('[bad](javascript:alert(1))')).not.toContain('<a'); expect(quoteMarkdown('[ok](https://x.io?a=1&b=2)')).toContain('a=1&amp;b=2');
  });
});
describe('read-only GitHub API', () => {
  test('uses GET token with timeout and projects paginated response', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const client = createGithubApi({ token: 'secret', fetch: async (url, init) => {
      requests.push({ url: String(url), init }); return Response.json([{ id: requests.length, user: { login: 'reviewer' }, state: 'APPROVED', commit_id: 'abc' }], { headers: requests.length === 1 ? { link: '<https://api.github.com/repos/o/r/pulls/7/reviews?per_page=100&page=2>; rel="next"' } : {} });
    } });
    expect(await client.reviews('o/r', 7)).toEqual([{ id: 1, login: 'reviewer', state: 'APPROVED', commitId: 'abc' }, { id: 2, login: 'reviewer', state: 'APPROVED', commitId: 'abc' }]);
    expect(requests[0]?.init?.method).toBe('GET'); expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe('Bearer secret'); expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
  test('missing token/HTTP error do not expose body or credentials', async () => {
    await expect(createGithubApi({}).reviews('o/r', 7)).rejects.toThrow('unavailable');
    await expect(createGithubApi({ token: 'secret', fetch: async () => new Response('private secret', { status: 403 }) }).reviews('o/r', 7)).rejects.toThrow('http_403');
  });
  test('rejects external pagination without leaking credentials', async () => {
    let requests = 0;
    const client = createGithubApi({ token: 'secret', fetch: async () => { requests++; return Response.json([], { headers: { link: '<https://evil.invalid/steal>; rel="next"' } }); } });
    await expect(client.reviews('o/r', 7)).rejects.toThrow('pagination'); expect(requests).toBe(1);
  });
});

describe('boundary regressions', () => {
  test('all cards remain valid and below limit with long escaped titles, people and URLs', async () => {
    const p = issue(); p.issue.title = '"<&'.repeat(1000);
    p.issue.assignees = Array.from({ length: 10 }, () => ({ login: '"<&'.repeat(30) }));
    p.issue.html_url = 'https://github.com/o/r/issues/5?' + 'a&'.repeat(500);
    const [m] = await formatGithub(delivery('issues', p), api(), config);
    expect(m!.html.length).toBeLessThan(4096);
    expect(m!.fallbackHtml?.length ?? 0).toBeLessThan(4096);
    expect(m!.html.match(/<a\b/g)?.length).toBe(m!.html.match(/<\/a>/g)?.length);
  });
  test('long push metadata also respects the serialized HTML limit', async () => {
    const p = push(); p.repository.full_name = 'o/' + '"<&'.repeat(200); p.ref = 'refs/heads/' + '"<&'.repeat(200);
    p.commits = Array.from({ length: 10 }, () => ({ id: 'abcdef0', message: '"'.repeat(1000), distinct: true }));
    const [m] = await formatGithub(delivery('push', p), api(), config);
    expect(m!.html.length).toBeLessThan(4096);
  });
  test('only matching force-push closure evidence produces an extra PR card', async () => {
    const prs = [
      { number: 7, title: 'Automatically closed', htmlUrl: 'https://github.com/o/r/pull/7', author: 'author', closedAt: '2026-10-24T12:00:00Z', merged: false, forcePushClosed: true },
      { number: 8, title: 'Manually closed', htmlUrl: 'https://github.com/o/r/pull/8', author: 'author', closedAt: '2026-10-24T12:00:00Z', merged: false, forcePushClosed: false },
      { number: 9, title: 'Old closure', htmlUrl: 'https://github.com/o/r/pull/9', author: 'author', closedAt: '2026-10-24T11:59:00Z', merged: false, forcePushClosed: true },
    ];
    const messages = await formatGithub(delivery('push', push(true)), api({ compare: async () => ({ commits: [] }), recentClosedPullRequests: async () => prs }), config);
    expect(messages).toHaveLength(2); expect(messages[1]?.html).toContain('Automatically closed');
    expect(messages[1]?.html).toContain('GitHub закрыл PR после force-push');
  });
  test('immediate verdict includes own current burst only and counts body plus inline notes', async () => {
    const p = { ...reviewFixture, action: 'submitted', pull_request: pr().pull_request,
      review: { id: 9, user: { login: 'reviewer', type: 'User' }, state: 'changes_requested', body: 'Поправь', submitted_at: '2026-10-24T12:00:00Z', html_url: 'https://github.com/o/r/pull/7#pullrequestreview-9' } };
    const [m] = await formatGithub(delivery('pull_request_review', p), api({ reviews: async () => [
      { id: 5, login: 'reviewer', state: 'COMMENTED', submittedAt: '2026-10-24T11:56:00Z', body: 'old' },
      { id: 7, login: 'reviewer', state: 'COMMENTED', submittedAt: '2026-10-24T11:59:00Z', htmlUrl: 'https://github.com/o/r/pull/7#pullrequestreview-7' },
      { id: 8, login: 'other', state: 'COMMENTED', submittedAt: '2026-10-24T11:59:30Z' },
      { id: 9, login: 'reviewer', state: 'CHANGES_REQUESTED', submittedAt: '2026-10-24T12:00:00Z', body: 'Поправь' },
      { id: 10, login: 'reviewer', state: 'COMMENTED', submittedAt: '2026-10-24T12:01:00Z', body: 'future' },
    ], reviewComments: async () => [5, 7, 8, 9, 9, 10].map(reviewId => ({ reviewId })) }), config);
    expect(m?.html).toContain('✋ Запрошены правки'); expect(m?.html).toContain('4 комментария');
    expect(m?.button?.url).toEndWith('#pullrequestreview-7');
  });
  test('first review / zero new commits / compare failure retain start-review button', async () => {
    const p = pr('review_requested');
    for (const mode of ['first', 'zero', 'failure']) {
      const [m] = await formatGithub(delivery('pull_request', p), api({
        reviews: async () => mode === 'first' ? [] : [{ id: 9, login: 'reviewer', state: 'APPROVED', commitId: 'aaa111' }],
        compare: async () => { if (mode === 'failure') throw new Error('private'); return { commits: [], aheadBy: 0 }; },
      }), { ...config, warn: () => {} });
      expect(m?.button?.text).toBe('Начать ревью');
      expect(m?.html).toContain(mode === 'first' ? 'Запрошено ревью' : 'Повторное ревью');
    }
  });
  test('inline code inside Markdown heading is restored, never leaks placeholder', () => {
    const q = quoteMarkdown('## `api/<id>`');
    expect(q).toContain('<code>api/&lt;id&gt;</code>'); expect(q).not.toContain('\u0000');
  });
  test('HTML images, autolinks and mail preserve content without multiline tag stripping', () => {
    const q = quoteMarkdown('<img src="https://i.io/a.png" />\n<details><summary>Ещё</summary>внутри</details>\n<user@mail.ru> <https://x.io>\nif x<y and\nmore y>z');
    expect(q).toContain('<a href="https://i.io/a.png">🖼 картинка</a>'); expect(q).toContain('Ещё\nвнутри');
    expect(q).toContain('user@mail.ru'); expect(q).toContain('<a href="https://x.io/">https://x.io</a>');
    expect(q).toContain('x&lt;y and\nmore y&gt;z');
  });
  test('API compare encodes refs, review comments and PR project minimal data', async () => {
    const urls: string[] = [];
    const client = createGithubApi({ token: 'secret', fetch: async url => {
      urls.push(url);
      if (url.includes('/compare/')) return Response.json({ ahead_by: 2, commits: [{ sha: 'abc', commit: { message: 'new' } }] });
      if (url.includes('/comments')) return Response.json([{ pull_request_review_id: 9 }]);
      return Response.json({ requested_reviewers: [{ login: 'reviewer' }] });
    } });
    expect(await client.compare('o/r', 'feature/a&', 'head#')).toEqual({ aheadBy: 2, commits: [{ sha: 'abc', message: 'new' }] });
    expect(urls[0]).toContain('/compare/feature%2Fa%26...head%23?');
    expect(await client.reviewComments('o/r', 7)).toEqual([{ reviewId: 9 }]);
    expect(await client.pullRequest('o/r', 7)).toEqual({ requestedReviewers: ['reviewer'] });
  });
  test('API classifies no-common-ancestor without exposing raw error', async () => {
    const client = createGithubApi({ token: 'secret', fetch: async () => new Response('No common ancestor between private refs', { status: 404 }) });
    await expect(client.compare('o/r', 'a', 'b')).rejects.toThrow('no_common_ancestor');
  });
  test('API aborts bounded request and hides network exception', async () => {
    const client = createGithubApi({ token: 'secret', timeoutMs: 5, fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private network details')), { once: true });
    }) });
    await expect(client.reviews('o/r', 7)).rejects.toThrow('timeout');
  });
  test('recent closed PR reads only first five and verifies both timeline events', async () => {
    const urls: string[] = [];
    const client = createGithubApi({ token: 'secret', fetch: async url => {
      urls.push(url);
      if (url.includes('/events')) return Response.json([{ event: 'closed', created_at: '2026-10-24T12:00:00Z' }, { event: 'head_ref_force_pushed', created_at: '2026-10-24T12:00:00Z' }]);
      if (url.includes('page=2')) throw new Error('must not paginate old closed PRs');
      return Response.json([{ number: 7, title: 'Closed', html_url: 'https://github.com/o/r/pull/7', user: { login: 'author' }, merged_at: null, closed_at: '2026-10-24T12:00:00Z' }], { headers: { link: '<https://api.github.com/repos/o/r/pulls?state=closed&page=2>; rel="next"' } });
    } });
    const result = await client.recentClosedPullRequests('o/r', 'feature/a');
    expect(result[0]?.forcePushClosed).toBe(true); expect(urls).toHaveLength(2); expect(urls[0]).toContain('head=o%3Afeature%2Fa');
  });
});
