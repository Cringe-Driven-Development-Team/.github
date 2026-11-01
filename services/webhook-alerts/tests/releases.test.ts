import { expect, test } from 'bun:test';
import { projectRelease, checkReleaseNotice } from '../src/releases';
import { openStore } from '../src/store';
import { deliverOnce } from '../src/worker';
import { releaseFixture, enqueue, status, delivery, REPO, A, B, C } from './helpers/release';
const config = { topic: 88, siteUrl: 'https://cellestial.ru', userMap: {} };
test('enqueue_uses_only_current_pr_and_rechecks_before_send', async () => {
  const f = releaseFixture(),
    [m] = await projectRelease(enqueue(), f.api, config);
  expect(m?.html).toContain('поставлен');
  expect(f.calls).toEqual(['queue']);
  f.queue.merged = true;
  f.queue.entry = null;
  expect(await checkReleaseNotice(m!.release!, f.api)).toBe('skip');
});
test('dequeued_merge_is_silent', async () => {
  const f = releaseFixture();
  expect(
    await projectRelease(
      delivery('pull_request', {
        action: 'dequeued',
        reason: 'MERGE',
        number: 125,
        pull_request: { number: 125, base: { ref: 'main' } },
      }),
      f.api,
      config,
    ),
  ).toEqual([]);
  expect(f.calls).toEqual([]);
});
test('reenqueued_entry_gets_new_notice_and_old_entry_retry_is_skipped', async () => {
  const f = releaseFixture(),
    [old] = await projectRelease(enqueue(), f.api, config);
  f.queue.entry = { id: 'ENTRY2', enqueuer: 'YarikMix', enqueuedAt: '2026-11-01T20:00:00Z' };
  const [next] = await projectRelease(enqueue(), f.api, config);
  expect(next!.release!.key).not.toBe(old!.release!.key);
  expect(await checkReleaseNotice(old!.release!, f.api)).toBe('skip');
});
test('stale_dequeued_after_reenqueue_is_skipped', async () => {
  const f = releaseFixture();
  expect(await projectRelease(enqueue('dequeued'), f.api, config)).toEqual([]);
});
test('queue_api_failure_defers_instead_of_claiming_current_membership', async () => {
  const f = releaseFixture();
  f.api.queue = async () => {
    throw new Error('unavailable');
  };
  expect(
    await checkReleaseNotice({ kind: 'queue', key: 'q', prNumber: 1, queueEntryId: 'ENTRY1' }, f.api),
  ).toBe('retry');
});
test('ready_uses_success_record_while_ci_running', async () => {
  const f = releaseFixture();
  f.operation.kind = 'publish';
  f.operation.run.workflow = 'CI';
  f.operation.run.event = 'push';
  const [m] = await projectRelease(status('success', 'release-artifacts'), f.api, config);
  expect(m!.html).toContain('ждёт выкатки');
  expect(m!.keyboard!.flat().some((b) => b.text === 'Выкатить')).toBe(true);
});
for (const readyFirst of [false, true])
  test(`publication_ready_and_lagging_job_fallback_have_one_result_ready_first_${readyFirst}`, async () => {
    const f = releaseFixture(),
      s = openStore(':memory:');
    f.operation.kind = 'publish';
    f.operation.run.workflow = 'CI';
    f.operation.run.event = 'push';
    f.job.name = 'Publish release';
    const job = delivery(
      'workflow_job',
      {
        action: 'completed',
        workflow_job: { id: 100, name: 'Publish release', conclusion: 'failure' },
      },
      2,
    );
    const ready = status('success', 'release-artifacts');
    try {
      s.activateReleases(500);
      for (const d of readyFirst ? [ready, job] : [job, ready]) {
        s.accept({
          source: d.source,
          deliveryId: d.deliveryId,
          event: d.event,
          raw: d.raw,
          receivedAt: 1000,
        });
        s.prepare(
          s.claimUnprepared(1000, 100, 'release-operation')[0]!.id,
          await projectRelease(d, f.api, config),
        );
      }
      const messages = s.claimDue(1000, 100);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.html).toContain('ждёт выкатки');
    } finally {
      s.close();
    }
  });
test('pending_publication_fallback_is_skipped_when_success_becomes_visible_before_send', async () => {
  const f = releaseFixture();
  f.job.run.workflow = 'CI';
  f.job.run.event = 'push';
  f.job.name = 'Publish release';
  const [message] = await projectRelease(
    delivery('workflow_job', {
      action: 'completed',
      workflow_job: { id: 100, name: 'Publish release', conclusion: 'failure' },
    }),
    f.api,
    config,
  );
  f.operation.kind = 'publish';
  f.job.operation = f.operation;
  expect(await checkReleaseNotice(message!.release!, f.api)).toBe('skip');
});
test('ready_replaces_fallback_waiting_for_guard_without_sending_its_old_content', async () => {
  const f = releaseFixture(),
    s = openStore(':memory:');
  f.operation.kind = 'publish';
  f.operation.run.workflow = 'CI';
  f.operation.run.event = 'push';
  f.job.name = 'Publish release';
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const checking = new Promise<void>((resolve) => (entered = resolve));
  const sent: string[] = [];
  try {
    s.activateReleases(500);
    const job = delivery(
      'workflow_job',
      {
        action: 'completed',
        workflow_job: { id: 100, name: 'Publish release', conclusion: 'failure' },
      },
      2,
    );
    s.accept({
      source: job.source,
      deliveryId: job.deliveryId,
      event: job.event,
      raw: job.raw,
      receivedAt: 1000,
    });
    s.prepare(
      s.claimUnprepared(1000, 100, 'release-operation')[0]!.id,
      await projectRelease(job, f.api, config),
    );
    const sending = deliverOnce({
      store: s,
      now: 1000,
      beforeReleaseSend: async () => {
        entered();
        await blocked;
        return 'send';
      },
      send: async (message) => {
        sent.push(message.html);
        return { kind: 'sent', telegramMessageId: 1 };
      },
    });
    await checking;
    const ready = status('success', 'release-artifacts');
    s.accept({
      source: ready.source,
      deliveryId: ready.deliveryId,
      event: ready.event,
      raw: ready.raw,
      receivedAt: 1000,
    });
    s.prepare(
      s.claimUnprepared(1000, 100, 'release-operation')[0]!.id,
      await projectRelease(ready, f.api, config),
    );
    release();
    await sending;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('ждёт выкатки');
    const repeat = status('success', 'release-artifacts');
    f.operation.run.id = 11;
    s.accept({
      source: repeat.source,
      deliveryId: 'republish',
      event: repeat.event,
      raw: repeat.raw,
      receivedAt: 1000,
    });
    s.prepare(
      s.claimUnprepared(1000, 100, 'release-operation')[0]!.id,
      await projectRelease(repeat, f.api, config),
    );
    expect(s.claimDue(1001, 100)).toHaveLength(0);
  } finally {
    release?.();
    s.close();
  }
});
test('foreign_repo_and_release_automation_cannot_recurse', async () => {
  const f = releaseFixture();
  expect(
    await projectRelease(
      delivery('deployment_status', {
        repository: { full_name: 'evil/repo' },
        deployment: { id: 1, environment: 'production' },
        deployment_status: { state: 'success' },
      }),
      f.api,
      config,
    ),
  ).toEqual([]);
  expect(await projectRelease(status('success', 'release-automation'), f.api, config)).toEqual([]);
  expect(f.calls).toEqual([]);
});
test('ready_already_present_in_production_is_skipped_even_after_rollback', async () => {
  const f = releaseFixture();
  f.history.push({
    id: 9,
    kind: 'deploy',
    sha: C,
    imageRef: f.operation.imageRef,
    everSucceeded: true,
    createdAt: '2026-11-01T19:00:00Z',
    runId: 9,
  });
  expect(
    await checkReleaseNotice(
      { kind: 'ready', key: 'ready', sha: B, operationKey: 'result:publish:10:1' },
      f.api,
    ),
  ).toBe('skip');
});
test('completed_operation_start_is_skipped', async () => {
  const f = releaseFixture();
  expect(await checkReleaseNotice({ kind: 'start', key: 'start', deploymentId: 1, runId: 10 }, f.api)).toBe(
    'skip',
  );
});
test('start_has_human_pr_title_and_logs_button', async () => {
  const f = releaseFixture();
  f.operation.state = 'in_progress';
  const [m] = await projectRelease(status('in_progress'), f.api, config);
  expect(m!.html).toContain('Human readable PR');
  expect(m!.keyboard!.flat().some((b) => b.text === 'Логи выкатки')).toBe(true);
});
for (const [state, steps, want] of [
  ['success', null, 'Health Check ✅'],
  ['failure', [{ name: 'Health check', outcome: 'failure' }], 'Health Check ❌'],
  ['error', null, 'Health Check ⚪'],
] as const)
  test(`health_${state}`, async () => {
    const f = releaseFixture();
    f.operation.state = state;
    f.operation.run.steps = steps ? steps.map((s) => ({ ...s })) : null;
    const [m] = await projectRelease(status(state), f.api, config);
    expect(m!.html).toContain(want);
    expect(m!.html).toContain(`href="https://github.com/${REPO}/issues/27"`);
  });
for (const count of [1, 6, 7])
  test(`pr_buttons_${count}`, async () => {
    const f = releaseFixture();
    f.report.prs = Array.from({ length: count }, (_, i) => ({
      number: 125 + i,
      title: `PR ${i}`,
      url: `https://github.com/${REPO}/pull/${125 + i}`,
      mergeSha: B,
    }));
    const [m] = await projectRelease(status(), f.api, config);
    const buttons = m!.keyboard!.flat();
    expect(buttons.filter((b) => /^PR(?: #\d+)?$/.test(b.text))).toHaveLength(count > 6 ? 0 : count);
    expect(buttons.some((b) => b.text === 'Все PR выпуска')).toBe(count > 6);
    expect(m!.keyboard!.every((row) => row.length <= 2)).toBe(true);
  });
test('job_before_status_uses_same_terminal_operation_key', async () => {
  const f = releaseFixture();
  const jobEvent = delivery('workflow_job', {
    action: 'completed',
    workflow_job: { id: 100, name: 'CD', conclusion: 'failure' },
  });
  const [first] = await projectRelease(jobEvent, f.api, config);
  f.operation.state = 'failure';
  const [next] = await projectRelease(status('failure'), f.api, config);
  expect(first!.release!.key).toBe(next!.release!.key);
});
test('terminal_failure_job_uses_operation_result_and_retention_is_separate', async () => {
  const f = releaseFixture();
  f.job.operation = f.operation;
  f.job.failedStep = 'Retention';
  const [m] = await projectRelease(
    delivery('workflow_job', {
      action: 'completed',
      workflow_job: { id: 100, name: 'CD', conclusion: 'failure' },
    }),
    f.api,
    config,
  );
  expect(m!.release!.kind).toBe('retention');
  expect(m!.html).toContain('Retention');
  expect(m!.html).not.toContain('Выкатка фронта: ошибка');
});
test('cancelled_job_before_operation_has_logs_and_attempt_key', async () => {
  const f = releaseFixture();
  f.job.conclusion = 'cancelled';
  const [m] = await projectRelease(
    delivery('workflow_job', {
      action: 'completed',
      workflow_job: { id: 100, name: 'CD', conclusion: 'cancelled' },
    }),
    f.api,
    config,
  );
  expect(m!.html).toContain('отмен');
  expect(m!.release!.key).toContain(':10:1');
});
test('html_is_escaped_and_missing_enrichment_does_not_hide_result', async () => {
  const f = releaseFixture();
  f.report.issues[0]!.title = '<unsafe>';
  const [m] = await projectRelease(status(), f.api, config);
  expect(m!.html).toContain('&lt;unsafe&gt;');
  f.api.changes = async () => {
    throw new Error('unavailable');
  };
  const [partial] = await projectRelease(status(), f.api, config);
  expect(partial!.html).toContain('успешно');
  expect(partial!.html).toContain('Состав изменений недоступен');
});
test('late_old_enqueue_and_job_before_activation_are_not_sent', async () => {
  const f = releaseFixture(),
    cutoffMs = Date.parse('2026-11-02T00:00:00Z');
  expect(await projectRelease(enqueue(), f.api, { ...config, cutoffMs })).toEqual([]);
  const old = delivery('workflow_job', {
    action: 'completed',
    workflow_job: {
      id: 100,
      name: 'CD',
      conclusion: 'failure',
      completed_at: '2026-11-01T20:00:00Z',
    },
  });
  expect(await projectRelease(old, f.api, { ...config, cutoffMs })).toEqual([]);
  const recovered = enqueue();
  recovered.releaseRecovery = true;
  expect(await projectRelease(recovered, f.api, { ...config, cutoffMs })).toHaveLength(1);
});
test('changed_live_base_branch_suppresses_pending_enqueue', async () => {
  const f = releaseFixture(),
    [message] = await projectRelease(enqueue(), f.api, config);
  f.queue.baseRef = 'other';
  expect(await checkReleaseNotice(message!.release!, f.api)).toBe('skip');
});
test('oversized_task_list_preserves_health_footer_and_valid_report_link', async () => {
  const f = releaseFixture();
  f.report.issues = Array.from({ length: 100 }, (_, i) => ({
    id: `I${i}`,
    number: i + 1,
    title: '<' + 'задача '.repeat(200),
    repo: REPO,
    prNumbers: [125],
  }));
  const [m] = await projectRelease(status(), f.api, config);
  expect(m!.html.length).toBeLessThanOrEqual(4095);
  expect(m!.html).toContain('Health Check ✅');
  expect(m!.html).toContain('Полный список PR и задач');
  expect((m!.html.match(/<a /g) || []).length).toBe((m!.html.match(/<\/a>/g) || []).length);
});
test('terminal_delivery_waits_when_api_still_shows_in_progress', async () => {
  const f = releaseFixture();
  f.operation.state = 'in_progress';
  await expect(projectRelease(status('success'), f.api, config)).rejects.toThrow();
});
test('canonical_successful_job_does_not_become_failure_from_delivery_snapshot', async () => {
  const f = releaseFixture();
  f.job.conclusion = 'success';
  expect(
    await projectRelease(
      delivery('workflow_job', {
        action: 'completed',
        workflow_job: { id: 100, name: 'CD', conclusion: 'failure' },
      }),
      f.api,
      config,
    ),
  ).toEqual([]);
});
test('rollback_start_is_labeled_as_rollback', async () => {
  const f = releaseFixture();
  f.operation.kind = 'rollback';
  f.operation.state = 'in_progress';
  const [m] = await projectRelease(status('in_progress'), f.api, config);
  expect(m!.html).toContain('Откат начался');
  expect(m!.keyboard!.flat()[0]!.text).toBe('Логи отката');
});
