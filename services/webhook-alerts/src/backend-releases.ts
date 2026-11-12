import { escapeHtml, fitHtml, link, mention, truncate } from './format';
import type { ReleaseApi, VerifiedJob, VerifiedOperation, VerifiedRun } from './release-api';
import type { OutgoingMessage } from './store';

export const BACKEND_REPO = 'Cringe-Driven-Development-Team/backend';
const root = `https://github.com/${BACKEND_REPO}`;
interface Config { topic: number; siteUrl: string; userMap?: Record<string, string | number> }
export function backendResultKey(kind: 'deploy' | 'rollback', run: VerifiedRun): string {
  return `result:${BACKEND_REPO}:${kind}:${run.id}:${run.attempt}`;
}
function evidence(run: VerifiedRun, successful: boolean) {
  const health = run.steps?.find(s => s.name === 'Health check')?.outcome;
  const switched = run.steps?.find(s => s.name === 'Switch backend')?.outcome;
  return {
    switched: switched === 'success',
    checked: successful || health === 'success',
    health: successful || health === 'success' ? '✅' : health === 'failure' ? '❌' : '⚪',
    state: successful || health === 'success' ? 'Выбранная версия подтверждена обязательными проверками.'
      : switched === 'success' ? 'Новая версия запущена на этапе переключения; итоговое состояние после проверки не подтверждено.'
      : switched === 'skipped' ? 'Переключение не выполнялось. Состояние прода: неизвестно.' : 'Состояние прода: неизвестно.',
    failed: run.steps?.find(s => s.outcome === 'failure' || s.outcome === 'cancelled')?.name,
  };
}
function buttons(run: VerifiedRun, config: Config, report: string, rollback: boolean,
  prRows: { text: string; url: string }[][] = [], compareUrl?: string) {
  return [
    [{ text: '🌐 Открыть прод', url: config.siteUrl }, { text: '↩️ Откатить', url: `${root}/actions/workflows/rollback.yml` }],
    ...prRows,
    [{ text: 'Полный отчёт', url: report }, ...(compareUrl ? [{ text: 'Изменения', url: compareUrl }] : [])],
    [{ text: rollback ? 'Логи отката' : 'Логи выкатки', url: `${run.url}/attempts/${run.attempt}` }],
  ];
}
export async function backendOperationMessage(op: VerifiedOperation, api: ReleaseApi, config: Config): Promise<OutgoingMessage> {
  if (op.kind === 'publish') throw new Error('backend publication is not a production operation');
  const rollback = op.kind === 'rollback', start = op.state === 'in_progress';
  const reportUrl = op.notification.report_url ?? `${op.run.url}#summary`;
  const fact = evidence(op.run, op.state === 'success');
  const lines = [
    `<b>${start ? '⏳' : fact.checked ? '✅' : '❌'} ${rollback ? 'Откат' : 'Выкатка'} бэка: ${start ? (rollback ? 'начался' : 'началась') : fact.checked ? 'успешно' : 'ошибка'}</b>`,
    `${escapeHtml(config.siteUrl)} · production`,
    ...(start ? [] : ['', `<b>Версия:</b> ${op.notification.base_sha ? link(op.notification.base_sha.slice(0,7), `${root}/commit/${op.notification.base_sha}`) : 'неизвестна'} → ${fact.checked || fact.switched ? link(op.sha.slice(0,7), `${root}/commit/${op.sha}`) : 'неизвестна'}`]),
    '',
  ];
  const taskLines = [`<b>${rollback ? 'Отменённые задачи' : 'Задачи'}</b>`];
  let prRows: { text: string; url: string }[][] = [];
  try {
    const changes = await api.changes(rollback ? op.sha : op.notification.base_sha, rollback ? (op.notification.base_sha ?? op.sha) : op.sha);
    if (!changes.complete || (rollback && op.notification.base_sha === null)) taskLines.push('Данные об изменениях неполные — см. полный отчёт.');
    else {
      const entries = [
        ...changes.issues.map(i => ({title:i.title,url:`https://github.com/${i.repo}/issues/${i.number}`})),
        ...changes.prs.filter(pr=>!changes.issues.some(i=>i.prNumbers.includes(pr.number))).map(pr=>({title:pr.title,url:pr.url})),
      ];
      if (entries.length===1) taskLines[0]=`<b>${rollback ? 'Отменённая задача' : 'Задача'}</b>`;
      taskLines.push(...entries.slice(0,3).map(i=>`• ${link(escapeHtml(truncate(i.title.replace(/\s+/g,' '),140)),i.url)}`));
      if (!entries.length) taskLines.push('Связанных изменений нет.');
      if (entries.length>3) taskLines.push(link('Остальные изменения в полном отчёте',reportUrl));
      const prs=changes.prs.slice(0,3).map(pr=>({text:changes.prs.length===1?'PR':`PR #${pr.number}`,url:pr.url}));
      for(let i=0;i<prs.length;i+=2) prRows.push(prs.slice(i,i+2));
    }
  } catch { taskLines.push('Данные об изменениях неполные — см. полный отчёт.'); }
  lines.push(...taskLines);
  if (!start) {
    lines.push('',`Health Check ${fact.health}`);
    if (!fact.checked) lines.push(fact.state);
    if (fact.failed) lines.push(`Этап сбоя: ${escapeHtml(fact.failed)}`);
    if (fact.checked && op.state !== 'success') lines.push('Проверки прошли; подробности последующей ошибки — в полном отчёте.');
  }
  lines.push('',`Запустил: ${mention(op.run.actor, config.userMap)}`);
  const compareUrl=op.notification.base_sha ? `${root}/compare/${rollback?op.sha:op.notification.base_sha}...${rollback?op.notification.base_sha:op.sha}` : undefined;
  const keyboard=buttons(op.run, config, reportUrl, rollback, prRows, compareUrl);
  return { topic:config.topic, html:fitHtml(lines.join('\n')), keyboard,
    release: {repository:BACKEND_REPO,action:op.kind,attempt:op.run.attempt,
      kind:start?'start':'result',key:start?`start:${BACKEND_REPO}:${op.id}`:backendResultKey(op.kind,op.run),deploymentId:op.id,runId:op.run.id} };
}
export function backendJobMessage(job: VerifiedJob, config: Config): OutgoingMessage {
  const rollback=job.run.workflow==='Rollback', kind=rollback?'rollback':'deploy', fact=evidence(job.run,false);
  const lines=[`<b>${fact.checked?'✅':job.conclusion==='cancelled'?'⚪':'❌'} ${rollback?'Откат':'Выкатка'} бэка: ${fact.checked?'успешно':job.conclusion==='cancelled'?'отменено':'ошибка'}</b>`,
    `${escapeHtml(config.siteUrl)} · production`, '', `Health Check ${fact.health==='❌'?'⚪':fact.health}`,
    fact.checked ? 'Проверки прошли; поздняя ошибка не меняет результат выкатки. Подробности — в полном отчёте.' : 'Состояние прода: неизвестно. Подробности — в полном отчёте.',
    `Этап сбоя: ${escapeHtml(job.failedStep??fact.failed??'см. логи')}`,'',`Запустил: ${mention(job.run.actor,config.userMap)}`];
  return {topic:config.topic,html:fitHtml(lines.join('\n')),keyboard:buttons(job.run,config,`${job.run.url}#summary`,rollback),
    release:{repository:BACKEND_REPO,action:kind,kind:'job-error',key:backendResultKey(kind,job.run),runId:job.run.id,attempt:job.run.attempt,jobId:job.id}};
}
