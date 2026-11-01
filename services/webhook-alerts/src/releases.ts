import { escapeHtml, fitHtml, link, mention, truncate } from './format';
import { GithubApiError } from './github-api';
import type { ChangeReport, OperationKind, ReleaseApi, VerifiedOperation, VerifiedRun } from './release-api';
import type { Delivery, OutgoingMessage, ReleaseNotice } from './store';
const REPO = 'Cringe-Driven-Development-Team/frontend',
  REPO_URL = `https://github.com/${REPO}`;
interface Config {
  topic: number;
  siteUrl: string;
  userMap?: Record<string, string | number>;
  cutoffMs?: number;
}
type Button = { text: string; url: string };
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new GithubApiError('invalid_event');
  return value;
}
function title(value: string, url: string): string {
  return `• ${link(escapeHtml(truncate(value.replace(/\s+/g, ' '), 140)), url)}`;
}
function resultKey(kind: OperationKind, run: VerifiedRun): string {
  return `result:${REPO}:${kind}:${run.id}:${run.attempt}`;
}
function health(op: VerifiedOperation): string[] {
  const steps = op.run.steps,
    checked = steps?.find((s) => s.name === 'Health check')?.outcome;
  const lines = [
    `Health Check ${op.state === 'success' || checked === 'success' ? '✅' : checked === 'failure' ? '❌' : '⚪'}`,
  ];
  const failed = steps?.find((s) => s.outcome === 'failure' || s.outcome === 'cancelled');
  if (failed) lines.unshift(`<b>Этап сбоя:</b> ${escapeHtml(failed.name)}`);
  if (op.state !== 'success' && checked !== 'success') {
    const switched = steps?.find((s) => s.name === 'Switch BFF')?.outcome;
    lines.push(
      switched === 'success'
        ? 'BFF переключён; проверка результата не подтверждена.'
        : switched === 'skipped'
          ? 'Переключение не выполнялось.'
          : 'Состояние прода не подтверждено — смотрите логи запуска.',
    );
  }
  return lines;
}
function bounded(header: string[], entries: string[], footer: string[], report: string | null): string {
  const tail = footer.join('\n'),
    more = report ? link('Полный список PR и задач', report) : 'Состав изменений показан не полностью';
  let text = header.join('\n');
  for (let i = 0; i < entries.length; i++) {
    const candidate = `${text}\n${entries[i]}`;
    if (candidate.length + tail.length + more.length + 4 > 4095) {
      text += `\n${more}`;
      break;
    }
    text = candidate;
  }
  return fitHtml(`${text}\n${tail}`);
}
function prButtons(report: ChangeReport | null, reportUrl: string | null): Button[][] {
  if (!report?.complete) return [];
  if (report.prs.length > 6) return reportUrl ? [[{ text: 'Все PR выпуска', url: reportUrl }]] : [];
  const buttons = report.prs.map((pr) => ({
      text: report.prs.length === 1 ? 'PR' : `PR #${pr.number}`,
      url: pr.url,
    })),
    rows: Button[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}
async function operationMessage(
  op: VerifiedOperation,
  api: ReleaseApi,
  config: Config,
): Promise<OutgoingMessage> {
  const start = op.state === 'in_progress',
    ready = op.kind === 'publish' && op.state === 'success',
    rollback = op.kind === 'rollback';
  let report: ChangeReport | null = null;
  try {
    report = await api.changes(
      rollback ? op.sha : op.notification.base_sha,
      rollback ? (op.notification.base_sha ?? op.sha) : op.sha,
    );
  } catch {
    report = null;
  }
  const entries = report?.complete
    ? start || ready
      ? report.prs.map((pr) => title(pr.title, pr.url))
      : [
          ...report.issues.map((issue) =>
            title(issue.title, `https://github.com/${issue.repo}/issues/${issue.number}`),
          ),
          ...report.prs
            .filter((pr) => !report!.issues.some((i) => i.prNumbers.includes(pr.number)))
            .map((pr) => title(pr.title, pr.url)),
        ]
    : ['Состав изменений недоступен'];
  if (report?.complete && !entries.length) entries.push('Связанных PR нет');
  const run = op.run,
    label = rollback ? 'Откат' : op.kind === 'publish' ? 'Заливка' : 'Выкатка';
  let header: string[], footer: string[], keyboard: Button[][], notice: ReleaseNotice;
  if (start) {
    header = [rollback ? 'Откат начался' : 'Выкатка началась'];
    footer = [`Запустил: ${mention(run.actor, config.userMap)}`];
    keyboard = [[{ text: rollback ? 'Логи отката' : 'Логи выкатки', url: run.url }]];
    notice = { kind: 'start', key: `start:${REPO}:${op.id}`, deploymentId: op.id, runId: run.id };
  } else if (ready) {
    header = ['📦 Релиз фронта залит, ждёт выкатки'];
    footer = [
      `Релиз <code>${op.sha}</code>`,
      `Образ BFF <code>${op.imageRef.split('@')[1]}</code>`,
      link('CI выпуска', run.url),
    ];
    keyboard = [
      [{ text: 'Выкатить', url: `${REPO_URL}/actions/workflows/cd.yml` }],
      ...prButtons(report, op.notification.report_url),
    ];
    notice = {
      kind: 'ready',
      key: `ready:${REPO}:${op.sha}`,
      sha: op.sha,
      operationKey: resultKey(op.kind, run),
    };
  } else {
    header = [
      `<b>${op.state === 'success' ? '✅' : '❌'} ${label} фронта: ${op.state === 'success' ? 'успешно' : 'ошибка'}</b>`,
      `${escapeHtml(config.siteUrl)} · production`,
      '',
      `<b>Версия:</b> ${op.notification.base_sha ? link(op.notification.base_sha.slice(0, 7), `${REPO_URL}/commit/${op.notification.base_sha}`) : 'неизвестна'} → ${link(op.sha.slice(0, 7), `${REPO_URL}/commit/${op.sha}`)}`,
      '<i>Слева — последний подтверждённый выпуск по истории GitHub Deployments, а не утверждение о текущем состоянии прода.</i>',
      '',
      `<b>${rollback ? 'Отменённые задачи' : 'Задачи'}</b>`,
    ];
    footer = [
      '',
      ...health(op),
      '',
      `Релиз <code>${op.sha}</code>`,
      `Образ BFF <code>${op.imageRef.split('@')[1]}</code>`,
      `Запустил: ${mention(run.actor, config.userMap)}`,
    ];
    keyboard = [
      [
        { text: '🌐 Открыть прод', url: config.siteUrl },
        { text: '↩️ Откатить', url: `${REPO_URL}/actions/workflows/rollback.yml` },
      ],
      ...prButtons(report, op.notification.report_url),
      [{ text: rollback ? 'Логи отката' : 'Логи выкатки', url: run.url }],
    ];
    notice = { kind: 'result', key: resultKey(op.kind, run), deploymentId: op.id, runId: run.id };
  }
  return {
    topic: config.topic,
    html: bounded(header, entries, footer, op.notification.report_url),
    keyboard,
    release: notice,
  };
}
export async function projectRelease(
  delivery: Delivery,
  api: ReleaseApi,
  config: Config,
): Promise<OutgoingMessage[]> {
  if (delivery.source !== 'github') return [];
  const payload = object(JSON.parse(new TextDecoder().decode(delivery.raw)));
  if (object(payload.repository).full_name !== REPO) return [];
  if (delivery.event === 'pull_request') {
    if (!['enqueued', 'dequeued'].includes(String(payload.action))) return [];
    const pr = object(payload.pull_request);
    if (object(pr.base).ref !== 'main') return [];
    const id = number(pr.number ?? payload.number);
    if (payload.number !== undefined && payload.number !== id) throw new GithubApiError('invalid_event');
    if (payload.action === 'dequeued' && payload.reason === 'MERGE') return [];
    const state = await api.queue(id);
    if (state.merged || state.baseRef !== 'main') return [];
    const url = `${REPO_URL}/pull/${id}`;
    if (payload.action === 'enqueued') {
      if (state.closed || !state.entry) return [];
      if (Date.parse(state.entry.enqueuedAt) < (config.cutoffMs ?? 0) && !delivery.releaseRecovery) return [];
      return [
        {
          topic: config.topic,
          html: `${link(`PR #${id}`, url)} поставлен в очередь\n${mention(state.entry.enqueuer, config.userMap)}`,
          keyboard: [[{ text: 'Открыть PR', url }]],
          release: {
            kind: 'queue',
            key: `queue:${REPO}:${state.entry.id}`,
            prNumber: id,
            queueEntryId: state.entry.id,
          },
        },
      ];
    }
    if (state.entry) return [];
    return [
      {
        topic: config.topic,
        html: `${link(`PR #${id}`, url)} снят с очереди\n${escapeHtml(truncate(typeof payload.reason === 'string' ? payload.reason : 'Причина не указана', 120))}`,
        keyboard: [[{ text: 'Открыть PR', url }]],
        release: { kind: 'dequeue', key: `dequeue:${REPO}:${delivery.deliveryId}`, prNumber: id },
      },
    ];
  }
  if (delivery.event === 'deployment_status') {
    const raw = object(payload.deployment),
      state = object(payload.deployment_status).state;
    if (
      payload.action !== 'created' ||
      !['production', 'release-artifacts'].includes(String(raw.environment)) ||
      !['in_progress', 'success', 'failure', 'error'].includes(String(state))
    )
      return [];
    if (raw.environment === 'release-artifacts' && state !== 'success') return [];
    let op: VerifiedOperation;
    try {
      op = await api.operation(number(raw.id));
    } catch (e) {
      if (
        e instanceof GithubApiError &&
        (e.code.startsWith('untrusted') || e.code === 'notification_missing')
      )
        return [];
      throw e;
    }
    if (Date.parse(op.createdAt) < (config.cutoffMs ?? 0) && !delivery.releaseRecovery) return [];
    if (state === 'in_progress' && op.state !== 'in_progress') return [];
    if (op.state === 'inactive') return [];
    if (state !== 'in_progress' && ['pending', 'queued', 'in_progress'].includes(op.state))
      throw new GithubApiError('operation_not_ready');
    if (op.kind === 'publish' && op.state !== 'success') throw new GithubApiError('publication_not_ready');
    return [await operationMessage(op, api, config)];
  }
  if (delivery.event === 'workflow_job') {
    const raw = object(payload.workflow_job);
    if (
      payload.action !== 'completed' ||
      !['CD', 'Rollback', 'Publish release'].includes(String(raw.name)) ||
      ['success', 'skipped', null, undefined].includes(raw.conclusion as null | undefined | string)
    )
      return [];
    if (
      Number.isFinite(Date.parse(String(raw.completed_at))) &&
      Date.parse(String(raw.completed_at)) < (config.cutoffMs ?? 0) &&
      !delivery.releaseRecovery
    )
      return [];
    const job = await api.job(number(raw.id)),
      run = job.run,
      kind = run.workflow === 'CI' ? 'publish' : run.workflow === 'CD' ? 'deploy' : 'rollback';
    if (job.conclusion === 'success' || job.conclusion === 'skipped') return [];
    if (job.operation && ['success', 'failure', 'error'].includes(job.operation.state)) {
      if (job.operation.state === 'success') {
        if (job.failedStep !== 'Retention') return [];
        return [
          {
            topic: config.topic,
            html:
              '⚠️ Выкатка проверена успешно, но завершилась ошибкой Retention\n' +
              link('Логи выкатки', run.url),
            keyboard: [[{ text: 'Логи выкатки', url: run.url }]],
            release: {
              kind: 'retention',
              key: `retention:${REPO}:${run.id}:${run.attempt}`,
              runId: run.id,
              attempt: run.attempt,
              jobId: job.id,
            },
          },
        ];
      }
      return [await operationMessage(job.operation, api, config)];
    }
    const label = kind === 'publish' ? 'Заливка' : kind === 'rollback' ? 'Откат' : 'Выкатка';
    return [
      {
        topic: config.topic,
        html: `${job.conclusion === 'cancelled' ? '⚪' : '❌'} ${label} фронта: ${job.conclusion === 'cancelled' ? 'отменено' : 'ошибка'}\nЭтап сбоя: ${escapeHtml(job.failedStep ?? 'см. логи запуска')}\n${kind === 'publish' ? '' : 'Health Check ⚪\n'}Запустил: ${mention(run.actor, config.userMap)}`,
        keyboard: [
          [
            {
              text:
                kind === 'rollback' ? 'Логи отката' : kind === 'publish' ? 'Логи публикации' : 'Логи выкатки',
              url: run.url,
            },
          ],
        ],
        release: {
          kind: 'job-error',
          key: resultKey(kind, run),
          runId: run.id,
          attempt: run.attempt,
          jobId: job.id,
        },
      },
    ];
  }
  return [];
}
export async function checkReleaseNotice(
  notice: ReleaseNotice,
  api: ReleaseApi,
): Promise<'send' | 'skip' | 'retry'> {
  try {
    if (notice.kind === 'queue' || notice.kind === 'dequeue') {
      const state = await api.queue(notice.prNumber);
      if (state.merged || state.baseRef !== 'main') return 'skip';
      if (notice.kind === 'queue')
        return !state.closed && state.entry?.id === notice.queueEntryId ? 'send' : 'skip';
      return state.entry ? 'skip' : 'send';
    }
    if (notice.kind === 'start')
      return (await api.operation(notice.deploymentId)).state === 'in_progress' ? 'send' : 'skip';
    if (notice.kind === 'job-error') {
      const job = await api.job(notice.jobId);
      if (job.conclusion === 'success' || job.conclusion === 'skipped' || job.operation?.state === 'success')
        return 'skip';
    }
    if (notice.kind === 'ready') {
      for (const production of await api.production())
        if (production.everSucceeded && (await api.isAncestor(notice.sha, production.sha))) return 'skip';
    }
    return 'send';
  } catch {
    return 'retry';
  }
}
