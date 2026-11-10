import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const workflow = (name: string): any => Bun.YAML.parse(readFileSync(join(root, '.github/workflows', `${name}.yml`), 'utf8'));
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
