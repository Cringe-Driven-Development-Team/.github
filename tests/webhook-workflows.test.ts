import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(import.meta.dir, '..');
const workflow = (name: string): any => Bun.YAML.parse(readFileSync(join(root, '.github/workflows', `${name}.yml`), 'utf8'));
// These job predicates use boolean operators/property access shared with JS.
// Empty vars match Actions' unset variables; comparisons ignore string case.
function enabled(expression: string | undefined, github: any, source = ''): boolean {
  if (expression === undefined) return true;
  const raw = expression.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, '');
  return Boolean(Function('github', 'vars', `return (${raw});`)(github, { TELEGRAM_EVENTS_SOURCE: source.toLowerCase() }));
}

test('webhook switch suppresses event notification while board, closing and reminders remain available', () => {
  const notify = workflow('telegram').jobs.notify;
  const board = workflow('add-to-project').jobs;
  const caller = workflow('automation').jobs;
  const reminders = workflow('reminders').jobs.remind;
  const issue = { event_name: 'issues', event: { action: 'opened' } };
  const merged = { event_name: 'pull_request', event: { action: 'closed', pull_request: { merged: true, base: { ref: 'main' } }, repository: { default_branch: 'main' } } };
  for (const [source, sends] of [['', true], ['actions', true], ['other', true], ['webhook', false], ['WEBHOOK', false]] as const) {
    expect(enabled(notify.if, issue, source)).toBe(sends);
    expect(enabled(caller.board.if, issue, source)).toBe(true);
    expect(enabled(caller.telegram.if, issue, source)).toBe(true);
    expect(enabled(board['add-to-project'].if, issue, source)).toBe(true);
    expect(enabled(board.close.if, merged, source)).toBe(true);
    expect(enabled(reminders.if, { event_name: 'schedule', event: {} }, source)).toBe(true);
    expect(enabled(reminders.if, { event_name: 'workflow_dispatch', event: {} }, source)).toBe(true);
  }
});

test('image publication is restricted to main pushes with package write permission', () => {
  const image = workflow('webhook-alerts-image');
  expect(Object.keys(image.on)).toEqual(['push']);
  expect(image.on.push.branches).toEqual(['main']);
  expect(image.permissions).toEqual({ contents: 'read', packages: 'write' });
  const job = image.jobs.publish;
  const trusted = { repository: 'Cringe-Driven-Development-Team/.github', event_name: 'push', ref: 'refs/heads/main' };
  expect(enabled(job.if, trusted)).toBe(true);
  for (const change of [{ event_name: 'pull_request' }, { ref: 'refs/heads/topic' }, { repository: 'other/.github' }]) {
    expect(enabled(job.if, { ...trusted, ...change })).toBe(false);
  }
});

function withPublisher(check: (run: (env?: Record<string, string>) => ReturnType<typeof Bun.spawnSync>, calls: () => string[]) => void) {
  const job = workflow('webhook-alerts-image').jobs.publish;
  const commands = job.steps.filter((step: any) => step.run).map((step: any) => step.run).join('\n');
  const tmp = mkdtempSync(join(tmpdir(), 'webhook-publish-'));
  try {
    writeFileSync(join(tmp, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_CALLS"\nif [ "$1" = push ]; then touch "$REGISTRY_STATE"; fi\n');
    chmodSync(join(tmp, 'docker'), 0o700);
    writeFileSync(join(tmp, 'curl'), `#!/bin/sh
url=
credentials=false
scope=false
authorized=false
for argument in "$@"; do
  case "$argument" in
    https://ghcr.io/*) url=$argument ;;
    synthetic-user:synthetic-token) credentials=true ;;
    scope=repository:cringe-driven-development-team/webhook-alerts:pull) scope=true ;;
    'Authorization: Bearer synthetic-registry-token') authorized=true ;;
  esac
done
for argument in "$@"; do
  if [ "$argument" = https://ghcr.io/token ]; then
    if [ "$credentials" != true ] || [ "$scope" != true ]; then exit 64; fi
    if [ "\${TOKEN_FAILURE:-false}" = true ]; then exit 22; fi
    printf '%s' '{"token":"synthetic-registry-token"}'
    exit
  fi
done
if [ "$url" != https://ghcr.io/v2/cringe-driven-development-team/webhook-alerts/manifests/sha-0123456789abcdef0123456789abcdef01234567 ] || [ "$authorized" != true ]; then exit 64; fi
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output=$2; shift; fi
  shift
done
if [ "\${REGISTRY_NETWORK_FAILURE:-false}" = true ]; then exit 7; fi
status=\${REGISTRY_STATUS:-404}
if [ -f "$REGISTRY_STATE" ]; then status=200; fi
if [ -n "\${REGISTRY_BODY+x}" ]; then
  printf '%s' "$REGISTRY_BODY" > "$output"
else
  printf '%s' '{"errors":[{"code":"MANIFEST_UNKNOWN"}]}' > "$output"
fi
printf '%s' "$status"
`);
    chmodSync(join(tmp, 'curl'), 0o700);
    const calls = join(tmp, 'calls');
    writeFileSync(calls, '');
    const run = (env: Record<string, string> = {}) => Bun.spawnSync(['bash', '-e', '-c', commands], { cwd: root, env: {
      ...process.env, PATH: `${tmp}:${process.env.PATH}`, DOCKER_CALLS: calls,
      REGISTRY_STATE: join(tmp, 'registry-state'), REGISTRY_USER: 'synthetic-user', REGISTRY_TOKEN: 'synthetic-token',
      REGISTRY_OWNER: 'Cringe-Driven-Development-Team', IMAGE_SHA: '0123456789abcdef0123456789abcdef01234567',
      ...env,
    } });
    check(run, () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

test('publisher builds service context and pushes only the full commit SHA tag', () => {
  withPublisher((run, calls) => {
    expect(run().exitCode).toBe(0);
    expect(calls()).toEqual([
      'build -t ghcr.io/cringe-driven-development-team/webhook-alerts:sha-0123456789abcdef0123456789abcdef01234567 services/webhook-alerts',
      'push ghcr.io/cringe-driven-development-team/webhook-alerts:sha-0123456789abcdef0123456789abcdef01234567',
    ]);
  });
});

test('publishing the same SHA twice preserves the existing image without rebuilding or pushing', () => {
  withPublisher((run, calls) => {
    expect(run().exitCode).toBe(0);
    const first = calls();
    expect(first).toHaveLength(2);
    expect(run().exitCode).toBe(0);
    expect(calls()).toEqual(first);
  });
});

test('same-SHA publication jobs serialize without cancelling a publisher', () => {
  const concurrency = workflow('webhook-alerts-image').jobs.publish.concurrency;
  expect(concurrency).toBeDefined();
  expect(concurrency.group).toContain('github.sha');
  expect(concurrency['cancel-in-progress']).toBe(false);
});

test.each([
  { TOKEN_FAILURE: 'true' }, { REGISTRY_NETWORK_FAILURE: 'true' },
  { REGISTRY_STATUS: '401' }, { REGISTRY_STATUS: '403' }, { REGISTRY_STATUS: '429' }, { REGISTRY_STATUS: '500' },
  { REGISTRY_STATUS: '404', REGISTRY_BODY: '{"errors":[{"code":"UNAUTHORIZED"}]}' },
  { REGISTRY_STATUS: '404', REGISTRY_BODY: '{"errors":[]}' },
  { REGISTRY_STATUS: '404', REGISTRY_BODY: '{"errors":[{"code":"MANIFEST_UNKNOWN"},{"code":"DENIED"}]}' },
  { REGISTRY_STATUS: '404', REGISTRY_BODY: 'upstream not found' },
])('registry/authentication errors fail closed before building or pushing: %j', env => {
  withPublisher((run, calls) => {
    expect(run(env).exitCode).not.toBe(0);
    expect(calls()).toEqual([]);
  });
});
