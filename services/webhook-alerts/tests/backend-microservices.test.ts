import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { checkReleaseNotice, projectRelease } from '../src/releases';
import { openStore } from '../src/store';
import contract from './fixtures/github/backend-microservices-contract.json';
import { A, B, backendApiFixture, repo } from './helpers/backend';
import { delivery } from './helpers/release';

const releaseTag = contract.deployment.payload.release_tag;
const runUrl = contract.deployment.payload.run;
const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const config = { topic: 3377, siteUrl: 'https://cellestial.ru', repository: repo };

function fixture() {
  const { api, state } = backendApiFixture();
  const data = structuredClone(contract);
  const terminal = { state: 'success', creator: { login: 'github-actions[bot]' }, log_url: runUrl + '/attempts/1', environment_url: config.siteUrl };
  let member = 'deployment-result.json';
  let corrupt = false;
  let missing = false;
  let redirect = false;
  const publications = [data.manifest];
  state.workflow = 'cd';
  state.event = 'workflow_dispatch';
  state.jobName = 'deploy';
  Object.assign(state.current, data.deployment);
  state.extra = (url, init) => {
    const path = url.pathname.replace(`/repos/${repo}`, '');
    if (path === '/deployments/2/statuses') return Response.json([terminal]);
    for (const [index, release] of publications.entries()) {
      const rowId = 3 + index * 100;
      const tag = 'release-' + release.source_sha;
      const manifest = JSON.stringify(release);
      const archiveRows = Object.values(release.services).map(({ archive }, archiveIndex) => ({
        id: rowId + archiveIndex + 10, name: archive.name, size: archive.size, digest: 'sha256:' + archive.sha256, state: 'uploaded',
      }));
      const sums = archiveRows.map(asset => `${asset.digest.slice(7)}  ${asset.name}\n`).join('') + `${digest(manifest)}  release.json\n`;
      const asset = (id: number, name: string, value: string) => ({
        id, name, size: Buffer.byteLength(value), digest: 'sha256:' + digest(value), state: 'uploaded',
      });
      if (path === `/releases/tags/${tag}` || path === `/releases/${rowId}`) return Response.json({
        id: rowId, tag_name: tag, draft: false, prerelease: false, immutable: true, author: { login: 'github-actions[bot]' },
        html_url: `https://github.com/${repo}/releases/tag/${tag}`, published_at: '2026-11-27T12:57:00Z',
        assets: [...archiveRows, asset(rowId + 1, 'release.json', manifest), asset(rowId + 2, 'SHA256SUMS', sums)],
      });
      if (path === `/git/ref/tags/${tag}`) return Response.json({ object: { type: 'commit', sha: release.source_sha } });
      if (path === `/releases/assets/${rowId + 1}`) return new Response(manifest);
      if (path === `/releases/assets/${rowId + 2}`) return new Response(sums);
      const runPath = '/actions/runs/' + release.ci_url.split('/').at(-1);
      if (path === runPath) return Response.json({
        id: Number(runPath.split('/').at(-1)), run_attempt: 1, workflow_id: 1, path: '.github/workflows/ci.yml',
        event: 'push', head_branch: 'main', head_sha: release.source_sha,
        repository: { full_name: repo }, head_repository: { full_name: repo }, actor: { login: 'GrayMouse9' },
      });
    }
    const bytes = zipSync({ [member]: new TextEncoder().encode(JSON.stringify(data.result)) });
    if (path === '/actions/runs/20/artifacts') return Response.json({ artifacts: missing ? [] : [{
      id: 7, name: 'backend-deployment-20-1', expired: false, size_in_bytes: bytes.length, digest: 'sha256:' + (corrupt ? '0'.repeat(64) : digest(bytes)),
    }] });
    if (path === '/actions/artifacts/7/zip') {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test');
      if (redirect) return new Response(null, {
        status: 302, headers: { location: 'https://productionresultssa1.blob.core.windows.net/result.zip?sig=synthetic' },
      });
      return new Response(Buffer.from(bytes));
    }
    if (url.hostname === 'productionresultssa1.blob.core.windows.net') {
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      return new Response(Buffer.from(bytes));
    }
  };
  return { api, state, data, terminal, publications,
    setMember: (name: string) => { member = name; }, corrupt: () => { corrupt = true; },
    discardArtifact: () => { missing = true; }, redirectArtifact: () => { redirect = true; },
  };
}

const status = (state = 'success') => delivery('deployment_status', {
  repository: { full_name: repo }, action: 'created', deployment: { id: 2, environment: 'production' },
  deployment_status: { state },
});

test('uses trusted mixed-service inventory and excludes unaffected services from the card', async () => {
  const { api, state, redirectArtifact } = fixture();
  redirectArtifact();
  const [card] = await projectRelease(status(), api, config);
  expect(card?.html).toContain('Выкатка бэка: успешно');
  expect(card?.html).toContain('Identity');
  expect(card?.html).toContain('Workspace');
  expect(card?.html).not.toContain('Environments');
  expect(card?.html).toContain('bbbbbbb');
  expect(card?.release?.key).toBe(`result:${repo}:deploy:20:1`);
  expect(state.calls.some(path => path.includes('backend-deployment-20-1'))).toBe(true);
});

test('partial deployment labels a failed service and reports unknown observed version', async () => {
  const { api, data, terminal } = fixture();
  terminal.state = 'failure';
  Reflect.deleteProperty(data.result.observed, 'workspace');
  data.result.checks.workspace.image = 'unknown';
  data.result.checks.workspace.ready = 'failed';
  const [card] = await projectRelease(status(), api, config);
  expect(card?.html).toContain('частично');
  expect(card?.html).toContain('Workspace');
  expect(card?.html).toContain('не подтверждена');
  expect(card?.html).not.toContain('Выкатка бэка: успешно');
});

test('publishing an immutable release produces a separate prepared card', async () => {
  const { api } = fixture();
  const [card] = await projectRelease(delivery('release', {
    repository: { full_name: repo }, action: 'published', release: { id: 3 },
  }), api, config);
  expect(card?.html).toContain('Релиз бэка подготовлен');
  expect(card?.html).toContain('Environments');
  expect(card?.html).not.toContain('Выкатка бэка: успешно');
  expect(await checkReleaseNotice(card!.release!, api, config)).toBe('send');
});

for (const invalid of ['attempt', 'digest', 'package', 'manifest-image', 'status-author', 'zip-path', 'success-check', 'foreign-run', 'archive', 'protocol', 'migration'] as const) {
  test(`refuses a successful card with invalid ${invalid} evidence`, async () => {
    const f = fixture();
    if (invalid === 'attempt') f.data.result.run_attempt = 2;
    if (invalid === 'digest') f.corrupt();
    if (invalid === 'package') f.data.deployment.payload.desired.identity.image_ref = f.data.manifest.services.workspace.image_ref;
    if (invalid === 'manifest-image') {
      f.data.deployment.payload.desired.identity.image_ref = f.data.manifest.services.identity.image_ref.replace(/4{64}$/, 'f'.repeat(64));
      f.data.result.desired.identity.image_ref = f.data.deployment.payload.desired.identity.image_ref;
    }
    if (invalid === 'status-author') f.terminal.creator.login = 'someone-else';
    if (invalid === 'zip-path') f.setMember('../deployment-result.json');
    if (invalid === 'success-check') f.data.result.checks.identity.smoke = 'unknown';
    if (invalid === 'foreign-run') f.state.workflow = 'ci', f.state.event = 'push', f.state.jobName = 'deploy / deploy';
    if (invalid === 'archive') f.data.manifest.services.identity.archive.name = 'bff-image.tar.gz';
    if (invalid === 'protocol') f.data.result.observed.identity.protocol_revision = B;
    if (invalid === 'migration') f.data.deployment.payload.desired.identity.migration_version = 0;
    await expect(f.api.operation(2)).rejects.toThrow();
  });
}

test('start card shows requested version and does not read unfinished artifact', async () => {
  const f = fixture();
  f.terminal.state = 'in_progress';
  f.discardArtifact();
  const [card] = await projectRelease(status('in_progress'), f.api, config);
  expect(card?.html).toContain('Выкатка бэка: началась');
  expect(card?.html).toContain('запрошен');
  expect(card?.html).not.toContain('подтверждён');
  expect(card?.release?.kind).toBe('start');
  expect(f.state.calls.every(url => !url.includes('/artifacts'))).toBe(true);
});

test('missing evidence after upload failure produces an unverified error card', async () => {
  const f = fixture();
  f.terminal.state = 'error';
  f.state.steps.push({ name: 'Upload deployment evidence', conclusion: 'failure' });
  f.discardArtifact();
  const [card] = await projectRelease(status('error'), f.api, config);
  expect(card?.html).toContain('Выкатка бэка: ошибка');
  expect(card?.html).toContain('проверки не подтверждены');
  expect(card?.html).not.toContain('успешно');
});

test('full rollback verifies source releases of each service in a mixed confirmed snapshot', async () => {
  const f = fixture();
  const previous = structuredClone(f.data.manifest);
  previous.source_sha = A;
  previous.ci_url = previous.ci_url.replace('/30', '/40');
  for (const service of ['environments', 'identity', 'workspace'] as const)
    Object.assign(previous.services[service], f.data.deployment.payload.before[service]);
  previous.services.environments.agent_version = A;
  f.publications.push(previous);
  f.state.workflow = 'rollback';
  f.state.jobName = 'rollback / deploy';
  f.state.current.task = f.data.deployment.payload.action = f.data.result.action = 'rollback';
  const version = (manifest: typeof f.data.manifest, service: keyof typeof manifest.services) => {
    return { ...manifest.services[service], protocol_revision: manifest.protocol_revision };
  };
  const before = {
    environments: version(f.data.manifest, 'environments'),
    identity: version(f.data.manifest, 'identity'),
    workspace: version(previous, 'workspace'),
  };
  const desired = {
    environments: version(previous, 'environments'),
    identity: version(previous, 'identity'),
    workspace: version(f.data.manifest, 'workspace'),
  };
  f.data.deployment.payload.selected_services.push('environments');
  f.data.result.selected_services.push('environments');
  Object.assign(f.data.deployment.payload, { before, desired });
  Object.assign(f.data.result, { before, desired, observed: desired });
  Object.assign(f.data.result.checks, { environments: { image: 'passed', ready: 'passed', smoke: 'passed' } });
  const [card] = await projectRelease(status(), f.api, config);
  expect(card?.html).toContain('Откат бэка: успешно');
  expect(card?.html).toContain('Environments');
  expect(card?.release?.key).toBe(`result:${repo}:rollback:20:1`);
  expect(f.state.calls.some(path => path.endsWith('/releases/tags/release-' + A))).toBe(true);
  expect(f.state.calls.some(path => path.endsWith('/releases/tags/release-' + B))).toBe(true);
});

test('backend publication and operation notices each deduplicate across deliveries', async () => {
  const { api } = fixture();
  const publication = delivery('release', {
    repository: { full_name: repo }, action: 'published', release: { id: 3 },
  });
  const operation = status();
  const store = openStore(':memory:');
  try {
    store.activateReleases(publication.receivedAt, repo);
    for (const [i, event] of [publication, operation, publication, operation].entries())
      store.accept({ ...event, deliveryId: `synthetic-${i}` });
    const deliveries = store.claimUnprepared(Date.now() + 1000, 30000, 'release-operation');
    expect(deliveries.map(event => event.event)).toEqual(['release', 'deployment_status', 'release', 'deployment_status']);
    for (const event of deliveries) store.prepare(event.id, await projectRelease(event, api, config));
    const pending = store.claimDue(Date.now() + 1000, 30000, 4, 'release-operation');
    expect(pending.map(row => row.release?.kind)).toEqual(['ready', 'result']);
  } finally { store.close(); }
});

for (const action of ['deploy', 'rollback'] as const) test(`shows only the selected service on single-service ${action}`, async () => {
  const f = fixture();
  if (action === 'rollback') {
    f.state.workflow = 'rollback';
    f.state.jobName = 'rollback / deploy';
    f.state.current.task = f.data.deployment.payload.action = f.data.result.action = action;
  }
  const untouched = f.data.deployment.payload.before.workspace;
  f.data.deployment.payload.selected_services.splice(1);
  f.data.result.selected_services.splice(1);
  f.data.deployment.payload.desired.workspace = untouched;
  f.data.result.desired.workspace = untouched;
  f.data.result.observed.workspace = untouched;
  Reflect.deleteProperty(f.data.result.checks, 'workspace');
  const compares: (string | null)[][] = [];
  f.api.changes = async (baseSha, headSha) => {
    compares.push([baseSha, headSha]);
    return {
      baseSha, headSha, complete: true, issues: [],
      prs: [{ number: 91, title: 'Identity change', url: `https://github.com/${repo}/pull/91`, mergeSha: headSha }],
    };
  };
  const [card] = await projectRelease(status(), f.api, config);
  expect(card?.html).toContain('Identity change');
  expect(card?.html).not.toContain('Workspace');
  expect(card?.html).not.toContain('Environments');
  expect(compares).toEqual(action === 'deploy' ? [[A, B]] : [[B, A]]);
  expect(card?.keyboard?.flat().some(button => button.text === 'PR #91')).toBe(true);
});
