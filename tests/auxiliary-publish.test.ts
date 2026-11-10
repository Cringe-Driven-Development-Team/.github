import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const root = join(import.meta.dir, '..');
const sha = '0123456789abcdef0123456789abcdef01234567';
const body = '{"schemaVersion":2}';
const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
function publish(env: Record<string, string> = {}, service = 'githubbot') {
  const tmp = mkdtempSync(join(tmpdir(), 'aux-publish-'));
  try {
    writeFileSync(join(tmp, 'curl'), `#!/usr/bin/env python3
import os,sys,json
args=sys.argv[1:]; url=args[-1]
if url.endswith('/token'):
 if os.environ.get('TOKEN_FAILURE'): sys.exit(22)
 if '--user' not in args and os.environ.get('PRIVATE'): sys.exit(22)
 print('{"token":"stub-token"}');sys.exit()
status=os.environ.get('STATUS','200')
if os.path.exists(os.environ['STATE']): status='200'
if '/manifests/sha256:' in url: status='200'
body=os.environ['BODY'] if status=='200' else os.environ.get('ERROR_BODY','{"errors":[{"code":"MANIFEST_UNKNOWN"}]}')
open(args[args.index('--output')+1],'w').write(body)
if '--dump-header' in args:
 d=os.environ['DIGEST']
 if '/manifests/sha256:' in url and os.environ.get('MISMATCH'): d='sha256:'+'b'*64
 open(args[args.index('--dump-header')+1],'w').write('HTTP/2 '+status+'\\r\\nDocker-Content-Digest: '+d+'\\r\\n')
print(status,end='')
`);
    writeFileSync(join(tmp, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
if [ "$1" = push ]; then touch "$STATE"; fi
if [ "$1" = pull ] && [ "\${FAIL_PULL:-}" = 1 ]; then exit 1; fi
if [ "$1 $2" = 'image inspect' ]; then printf '%s\\n' "\${SOURCE:-https://github.com/Cringe-Driven-Development-Team/.github}"; fi
`);
    for (const command of ['curl', 'docker']) chmodSync(join(tmp, command), 0o700);
    const result = Bun.spawnSync(['bash', join(root, 'scripts/auxiliary-publish.sh'), service, 'local:test'], { cwd: tmp, env: {
      ...process.env, PATH: `${tmp}:${process.env.PATH}`, IMAGE_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
      REGISTRY_USER: 'user', REGISTRY_TOKEN: 'token', BODY: body, DIGEST: digest,
      CALLS: join(tmp, 'calls'), STATE: join(tmp, 'state'), GITHUB_OUTPUT: join(tmp, 'output'), ...env,
    }});
    const calls = existsSync(join(tmp, 'calls')) ? readFileSync(join(tmp, 'calls'), 'utf8') : '';
    return { exitCode: result.exitCode, stderr: result.stderr.toString(), publishCalls: calls.split('\n').filter(c => c.startsWith('push ')).length,
      release: existsSync(join(tmp, 'release.json')) ? JSON.parse(readFileSync(join(tmp, 'release.json'), 'utf8')) : null,
      output: existsSync(join(tmp, 'output')) ? readFileSync(join(tmp, 'output'), 'utf8') : '' };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
for (const service of ['githubbot', 'webhook-alerts']) {
  test(`${service} preserves existing immutable tag and emits verified Release/output`, () => {
    const result = publish({}, service);
    expect(result.exitCode).toBe(0);
    expect(result.publishCalls).toBe(0);
    expect(result.release).toEqual({ service, image_ref: `ghcr.io/cringe-driven-development-team/${service}@${digest}`, source_sha: sha, publisher_run_id: 123, publisher_run_attempt: 2 });
    expect(result.output).toBe(`image_ref=${result.release.image_ref}\n`);
  });
}
test.each(['MANIFEST_UNKNOWN', 'NAME_UNKNOWN'])('confirmed missing tag %s pushes once', code => {
  const result = publish({ STATUS: '404', ERROR_BODY: JSON.stringify({errors: [{code}]}) });
  expect(result.exitCode).toBe(0);
  expect(result.publishCalls).toBe(1);
});
test.each(['401', '403', '429', '500'])('HTTP %s fails closed', STATUS => {
  const result = publish({ STATUS }); expect(result.exitCode).not.toBe(0); expect(result.publishCalls).toBe(0); expect(result.release).toBeNull();
});
test.each(['{"errors":[]}', '{"errors":[{"code":"DENIED"}]}', 'not found'])('unconfirmed 404 fails closed: %s', ERROR_BODY => {
  const result = publish({ STATUS: '404', ERROR_BODY }); expect(result.exitCode).not.toBe(0); expect(result.publishCalls).toBe(0);
});
test.each([{ TOKEN_FAILURE: '1' }, { FAIL_PULL: '1' }, { MISMATCH: '1' }, { DIGEST: `sha256:${'a'.repeat(64)}` }, { PRIVATE: '1' }, { SOURCE: 'https://example.com/wrong' }, { IMAGE_SHA: 'bad' }, { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ATTEMPT: 'x' }])('verification rejects invalid publication: %j', env => {
  const result = publish(env); expect(result.exitCode).not.toBe(0); expect(result.release).toBeNull(); expect(result.output).toBe('');
});

const workflow = (name: string): any => Bun.YAML.parse(readFileSync(join(root, '.github/workflows', `${name}.yml`), 'utf8'));
test.each([
  ['services/githubbot/src/main.ts', true, false], ['services/webhook-alerts/src/worker.ts', false, true],
  ['services/webhook-alerts/src/format.ts', true, true], ['services/githubbot/README.md', false, false],
  ['services/webhook-alerts/README.md', false, false], ['scripts/auxiliary-publish.sh', true, true],
  ['tests/auxiliary-publish.test.ts', true, true], ['tests/githubbot-docker.sh', true, false],
  ['tests/webhook-alerts-docker.sh', false, true], ['tests/githubbot-workflows.test.ts', true, false],
  ['tests/webhook-workflows.test.ts', false, true], ['.github/workflows/githubbot-image.yml', true, false],
  ['.github/workflows/webhook-alerts-image.yml', false, true],
])('push path %s independently selects publishers', (path, bot, alerts) => {
  for (const [service, expected] of [['githubbot', bot], ['webhook-alerts', alerts]] as const) {
    const paths = workflow(`${service}-image`).on.push.paths;
    expect(Array.isArray(paths)).toBe(true);
    expect(paths.some((pattern: string) => new Bun.Glob(pattern).match(path))).toBe(expected);
  }
});
test.each(['githubbot', 'webhook-alerts'])('%s publisher uploads only after gates with machine output', service => {
  const job = workflow(`${service}-image`).jobs.publish;
  expect(job.concurrency['cancel-in-progress']).toBe(false);
  expect(job.concurrency.group).toContain('github.sha');
  expect(job.outputs.image_ref).toBe('${{ steps.release.outputs.image_ref }}');
  const release = job.steps.findIndex((s: any) => s.id === 'release');
  const login = job.steps.findIndex((s: any) => s.uses?.startsWith('docker/login-action'));
  const smoke = job.steps.findIndex((s: any) => s.run?.includes(`bash tests/${service}-docker.sh`));
  expect(smoke).toBeGreaterThan(-1); expect(login).toBeGreaterThan(smoke); expect(release).toBeGreaterThan(login);
  const upload = job.steps.findIndex((s: any) => s.uses?.startsWith('actions/upload-artifact@'));
  expect(upload).toBeGreaterThan(release);
  expect(job.steps[upload].with).toMatchObject({name: `release-${service}-\${{ github.run_attempt }}`, path: 'release.json', 'if-no-files-found': 'error'});
});

for (const service of ['githubbot', 'webhook-alerts']) {
  test.each(['test', 'typecheck', 'build', 'smoke'])(`${service} failed %s gate prevents publication`, gate => {
    const tmp = mkdtempSync(join(tmpdir(), 'aux-gates-'));
    try {
      for (const command of ['bun', 'docker', 'bash']) {
        writeFileSync(join(tmp, command), `#!/bin/sh
case "$*" in
  *auxiliary-publish.sh*) touch "$PUBLISHED" ;;
  *docker.sh*) [ "$FAIL_GATE" != smoke ] ;;
  test*) [ "$FAIL_GATE" != test ] ;;
  *typecheck*) [ "$FAIL_GATE" != typecheck ] ;;
  build*) [ "$FAIL_GATE" != build ] ;;
esac
`);
        chmodSync(join(tmp, command), 0o700);
      }
      const commands = workflow(`${service}-image`).jobs.publish.steps.filter((s: any) => s.run).map((s: any) => s.run).join('\n');
      const result = Bun.spawnSync(['/bin/bash', '-e', '-c', commands], {cwd: root, env: {...process.env, PATH: `${tmp}:${process.env.PATH}`, FAIL_GATE: gate, PUBLISHED: join(tmp, 'published')}});
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(join(tmp, 'published'))).toBe(false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}
