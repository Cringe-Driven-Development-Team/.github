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
    checked: successful || health === 'success',
    health: successful || health === 'success' ? '✅' : health === 'failure' ? '❌' : '⚪',
    state: successful || health === 'success' ? 'Выбранная версия подтверждена обязательными проверками.'
      : switched === 'success' ? 'Новая версия запущена на этапе переключения; итоговое состояние после проверки не подтверждено.'
      : switched === 'skipped' ? 'Переключение не выполнялось. Состояние прода: неизвестно.' : 'Состояние прода: неизвестно.',
    failed: run.steps?.find(s => s.outcome === 'failure' || s.outcome === 'cancelled')?.name,
  };
}
function buttons(run: VerifiedRun, config: Config, report: string, rollback: boolean) {
  return [
    [{ text: '🌐 Открыть прод', url: config.siteUrl }, { text: '↩️ Откатить', url: `${root}/actions/workflows/rollback.yml` }],
    [{ text: 'Полный отчёт', url: report }, { text: rollback ? 'Логи отката' : 'Логи выкатки', url: `${run.url}/attempts/${run.attempt}` }],
  ];
}
export async function backendOperationMessage(op: VerifiedOperation, api: ReleaseApi, config: Config): Promise<OutgoingMessage> {
  if (op.kind === 'publish') throw new Error('backend publication is not a production operation');
  const rollback = op.kind === 'rollback', start = op.state === 'in_progress';
  const reportUrl = op.notification.report_url ?? `${op.run.url}#summary`;
  const fact = evidence(op.run, op.state === 'success');
  const lines = [
    `<b>${start ? '⏳' : fact.checked ? '✅' : '❌'} ${rollback ? 'Откат' : 'Выкатка'} backend: ${start ? 'начался' : fact.checked ? 'проверена успешно' : 'ошибка'}</b>`,
    `${escapeHtml(config.siteUrl)} · production`,
    `Последний подтверждённый релиз: ${op.notification.base_sha ? link(op.notification.base_sha.slice(0, 7), `${root}/commit/${op.notification.base_sha}`) : 'нет данных'}`,
    '<i>Это последний подтверждённый результат из GitHub, не проверка текущего состояния VPS.</i>',
    `Целевая версия: ${link(op.sha.slice(0, 7), `${root}/commit/${op.sha}`)}`,
    `<code>${op.sha}</code>`, `<code>${escapeHtml(op.imageRef)}</code>`,
    ...(start ? [] : [`Health Check ${fact.health}`, fact.state, ...(fact.failed ? [`Этап сбоя: ${escapeHtml(fact.failed)}`] : [])]),
    '', `<b>${rollback ? 'Снимаемые изменения' : 'Изменения'}</b>`,
  ];
  let prRows: { text: string; url: string }[][] = [];
  try {
    const changes = await api.changes(rollback ? op.sha : op.notification.base_sha, rollback ? (op.notification.base_sha ?? op.sha) : op.sha);
    if (!changes.complete || (rollback && op.notification.base_sha === null)) lines.push('Данные об изменениях неполные — см. Summary.');
    else {
      const entries = [
        ...changes.issues.map(i => ({title:i.title,url:`https://github.com/${i.repo}/issues/${i.number}`})),
        ...changes.prs.filter(pr=>!changes.issues.some(i=>i.prNumbers.includes(pr.number))).map(pr=>({title:pr.title,url:pr.url})),
      ];
      lines.push(...entries.slice(0,3).map(i=>`• ${link(escapeHtml(truncate(i.title.replace(/\s+/g,' '),140)),i.url)}`));
      if (!entries.length) lines.push('Связанных изменений нет.');
      if (entries.length>3) lines.push(link('Остальные изменения в Summary',reportUrl));
      prRows=changes.prs.slice(0,3).map(pr=>[{text:`PR #${pr.number}`,url:pr.url}]);
    }
  } catch { lines.push('Данные об изменениях неполные — см. Summary.'); }
  lines.push(`Запустил: ${mention(op.run.actor, config.userMap)}`);
  if (!start && fact.checked && op.state !== 'success') lines.push('Обязательные проверки прошли; итоговый Deployment требует сверки по логам.');
  const keyboard=buttons(op.run, config, reportUrl, rollback);
  if (op.notification.base_sha) keyboard.push([{text:'Изменения',url:`${root}/compare/${rollback?op.sha:op.notification.base_sha}...${rollback?op.notification.base_sha:op.sha}`}]);
  keyboard.push(...prRows);
  return { topic:config.topic, html:fitHtml(lines.join('\n')), keyboard,
    release: {repository:BACKEND_REPO,action:op.kind,attempt:op.run.attempt,
      kind:start?'start':'result',key:start?`start:${BACKEND_REPO}:${op.id}`:backendResultKey(op.kind,op.run),deploymentId:op.id,runId:op.run.id} };
}
export function backendJobMessage(job: VerifiedJob, config: Config): OutgoingMessage {
  const rollback=job.run.workflow==='Rollback', kind=rollback?'rollback':'deploy', fact=evidence(job.run,false);
  const lines=[`<b>${fact.checked?'✅':job.conclusion==='cancelled'?'⚪':'❌'} ${rollback?'Откат':'Выкатка'} backend: ${fact.checked?'проверена успешно':job.conclusion==='cancelled'?'отменено':'ошибка'}</b>`,
    `${escapeHtml(config.siteUrl)} · production`, `Health Check ${fact.health==='❌'?'⚪':fact.health}`,
    fact.checked ? 'Проверки прошли; поздняя ошибка не меняет результат выкатки. Итоговый Deployment не подтверждён.' : 'Целевая версия и состояние прода: неизвестно. Смотрите Summary и логи.',
    `Этап сбоя: ${escapeHtml(job.failedStep??fact.failed??'см. логи')}`,`Запустил: ${mention(job.run.actor,config.userMap)}`];
  return {topic:config.topic,html:fitHtml(lines.join('\n')),keyboard:buttons(job.run,config,`${job.run.url}#summary`,rollback),
    release:{repository:BACKEND_REPO,action:kind,kind:'job-error',key:backendResultKey(kind,job.run),runId:job.run.id,attempt:job.run.attempt,jobId:job.id}};
}
