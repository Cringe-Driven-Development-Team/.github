import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(import.meta.dir, '..');
const workflow = (name: string): any => Bun.YAML.parse(readFileSync(join(root, '.github/workflows', `${name}.yml`), 'utf8'));
const sha = '0123456789abcdef0123456789abcdef01234567';
const image = `ghcr.io/cringe-driven-development-team/githubbot:sha-${sha}`;
const digest = `ghcr.io/cringe-driven-development-team/githubbot@sha256:${'a'.repeat(64)}`;

test('PR checks test, typecheck, build root context and smoke without publishing', () => {
  const checks = workflow('checks');
  expect(checks.on).toHaveProperty('pull_request');
  const job = checks.jobs.githubbot;
  expect(job.if).toBeUndefined();
  const commands = job.steps.filter((step: any) => step.run).map((step: any) => step.run).join('\n');
  expect(commands).toContain('bun test services/githubbot/tests tests/githubbot-workflows.test.ts');
  expect(commands).toContain('bun run --cwd services/githubbot typecheck');
  const buildCommand = commands.split('\n').find((line: string) => line.startsWith('docker build'));
  expect(buildCommand).toContain('-f services/githubbot/Dockerfile');
  expect(buildCommand.endsWith(' .')).toBe(true);
  expect(commands).toContain('bash tests/githubbot-docker.sh githubbot:test');
  expect(commands).not.toMatch(/docker (push|login)/);
  expect(job.steps.some((step: any) => step.uses?.startsWith('docker/login-action'))).toBe(false);
});

test('publication only permits trusted push/main and package writes', () => {
  const imageWorkflow = workflow('githubbot-image');
  expect(Object.keys(imageWorkflow.on)).toEqual(['push']);
  expect(imageWorkflow.on.push.branches).toEqual(['main']);
  expect(imageWorkflow.permissions).toEqual({ contents: 'read', packages: 'write' });
  const job = imageWorkflow.jobs.publish;
  const enabled = (github: any) => Boolean(Function('github', `return (${job.if});`)(github));
  const trusted = { repository: 'Cringe-Driven-Development-Team/.github', event_name: 'push', ref: 'refs/heads/main' };
  expect(enabled(trusted)).toBe(true);
  for (const change of [{ repository: 'other/.github' }, { event_name: 'pull_request' }, { ref: 'refs/heads/topic' }]) {
    expect(enabled({ ...trusted, ...change })).toBe(false);
  }
  const login = job.steps.findIndex((step: any) => step.uses?.startsWith('docker/login-action'));
  const smoke = job.steps.findIndex((step: any) => step.run?.includes('bash tests/githubbot-docker.sh'));
  expect(smoke).toBeGreaterThan(-1);
  expect(login).toBeGreaterThan(smoke);
  expect(job.steps.find((step: any) => step.env?.IMAGE_SHA)?.env.IMAGE_SHA).toBe('${{ github.sha }}');
});

function publisher(check: (run: (env?: Record<string, string>) => ReturnType<typeof Bun.spawnSync>, calls: () => string[]) => void) {
  const job = workflow('githubbot-image').jobs.publish;
  const tmp = mkdtempSync(join(tmpdir(), 'githubbot-publish-'));
  try {
    // External command boundaries only; the real workflow shell enforces failure ordering.
    for (const command of ['bun', 'bash', 'docker']) {
      const path = join(tmp, command);
      writeFileSync(path, `#!/bin/sh
printf '%s\\n' '${command} '"$*" >> "$CALLS"
if [ '${command}' = bun ] && [ "$1" = test ] && [ "\${FAIL_TEST:-}" = 1 ]; then exit 1; fi
if [ '${command}' = bun ] && [ "$1 $2" = 'run --cwd' ] && [ "\${FAIL_TYPECHECK:-}" = 1 ]; then exit 1; fi
if [ '${command}' = bash ] && [ "\${FAIL_SMOKE:-}" = 1 ]; then exit 1; fi
if [ '${command}' = docker ] && [ "$1" = pull ] && [ "\${FAIL_PULL:-}" = 1 ]; then exit 1; fi
if [ '${command}' = docker ] && [ "$1 $2" = 'image inspect' ]; then printf '%s\\n' "$REGISTRY_DIGEST"; fi
`);
      chmodSync(path, 0o700);
    }
    writeFileSync(join(tmp, 'calls'), '');
    const commands = job.steps.filter((step: any) => step.run).map((step: any) => step.run).join('\n');
    const run = (env: Record<string, string> = {}) => Bun.spawnSync(['/bin/bash', '-e', '-c', commands], { cwd: root, env: {
      ...process.env, PATH: `${tmp}:${process.env.PATH}`, CALLS: join(tmp, 'calls'),
      REGISTRY_OWNER: 'Cringe-Driven-Development-Team', IMAGE_SHA: sha, REGISTRY_DIGEST: digest,
      GITHUB_STEP_SUMMARY: join(tmp, 'summary'), ...env,
    } });
    check(run, () => readFileSync(join(tmp, 'calls'), 'utf8').trim().split('\n').filter(Boolean));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

test('publisher verifies tests and image before full SHA publication and remote digest', () => {
  publisher((run, calls) => {
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(calls()).toEqual([
      'bun install --frozen-lockfile --cwd services/githubbot',
      'bun test services/githubbot/tests tests/githubbot-workflows.test.ts',
      'bun run --cwd services/githubbot typecheck',
      'docker build -f services/githubbot/Dockerfile -t githubbot:test .',
      'bash tests/githubbot-docker.sh githubbot:test',
      `docker tag githubbot:test ${image}`, `docker push ${image}`, `docker pull ${image}`,
      `docker image inspect ${image} --format {{index .RepoDigests 0}}`,
    ]);
    expect(result.stdout.toString()).toContain(digest);
  });
});

test.each([{ FAIL_TEST: '1' }, { FAIL_TYPECHECK: '1' }, { FAIL_SMOKE: '1' }])('failed verification prevents publication: %j', env => {
  publisher((run, calls) => {
    expect(run(env).exitCode).not.toBe(0);
    expect(calls().some(call => call.startsWith('docker push'))).toBe(false);
  });
});

test.each([
  { FAIL_PULL: '1' }, { REGISTRY_DIGEST: '' }, { REGISTRY_DIGEST: 'wrong@sha256:abc' },
  { REGISTRY_DIGEST: `ghcrXio/cringe-driven-development-team/githubbot@sha256:${'a'.repeat(64)}` },
])('remote verification failure fails publication job: %j', env => {
  publisher((run) => { expect(run(env).exitCode).not.toBe(0); });
});
