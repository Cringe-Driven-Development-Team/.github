import { expect, test } from 'bun:test';
import { projectRelease } from '../src/releases';
import { releaseFixture, delivery, A, B } from './helpers/release';
const repo='Cringe-Driven-Development-Team/backend';
const config={topic:3377,siteUrl:'https://cellestial.ru',repository:repo};
function fixture(){
  const f=releaseFixture();
  f.operation.imageRef=`ghcr.io/cringe-driven-development-team/backend@sha256:${'d'.repeat(64)}`;
  f.operation.run.workflow='CI';f.operation.run.event='push';f.operation.run.headSha=B;
  f.operation.run.url=`https://github.com/${repo}/actions/runs/10`;
  f.operation.notification.report_url=f.operation.run.url+'#summary';
  f.operation.run.steps=[{name:'Switch backend',outcome:'success'},{name:'Health check',outcome:'success'}];
  f.job.name='deploy / deploy';
  return f;
}
const status=()=>delivery('deployment_status',{repository:{full_name:repo},action:'created',deployment:{id:1,environment:'production'},deployment_status:{state:'success'}});
const job=()=>delivery('workflow_job',{repository:{full_name:repo},action:'completed',workflow_job:{id:100,name:'deploy / deploy',conclusion:'failure'}});
test('backend result has confirmed versions, digest, Summary, three changes and workflow-only rollback',async()=>{
  const f=fixture();
  f.report.issues=Array.from({length:5},(_,i)=>({id:`I${i}`,number:i+1,title:`Backend change ${i}`,repo,prNumbers:[125]}));
  const [card]=await projectRelease(status(),f.api,config);
  expect(card?.topic).toBe(3377);expect(card?.html).toContain('Выкатка backend');expect(card?.html).toContain('Health Check ✅');
  expect(card?.html).toContain('последний подтверждённый');expect(card?.html).toContain('backend@sha256:');
  expect(card?.html.match(/Backend change/g)).toHaveLength(3);
  expect(JSON.stringify(card?.keyboard)).toContain('actions/workflows/rollback.yml');
  expect(JSON.stringify(card?.keyboard)).toContain('runs/10#summary');
  expect(card?.release?.key).toBe(`result:${repo}:deploy:10:1`);
});
test('backend switch and health fail are distinguished from old historical release',async()=>{
  const f=fixture();f.operation.state='failure';f.operation.run.steps![1]!.outcome='failure';
  const [card]=await projectRelease(status(),f.api,config);
  expect(card?.html).toContain('Health Check ❌');expect(card?.html).toContain('Новая версия запущена');
  f.operation.run.steps![0]!.outcome='cancelled';f.operation.run.steps![1]!.outcome='skipped';
  expect((await projectRelease(status(),f.api,config))[0]?.html).toContain('Состояние прода: неизвестно');
});
test('backend fallback before Deployment has no invented target and late health success is preserved',async()=>{
  const f=fixture();f.job.operation=null;f.job.run.steps=[{name:'Prepare target',outcome:'failure'},{name:'Switch backend',outcome:'skipped'},{name:'Health check',outcome:'skipped'}];
  let [card]=await projectRelease(job(),f.api,config);
  expect(card?.html).toContain('Health Check ⚪');expect(card?.html).toContain('неизвестно');expect(card?.html).not.toContain('→');
  f.job.run.steps=[{name:'Switch backend',outcome:'success'},{name:'Health check',outcome:'success'},{name:'Summary',outcome:'failure'}];
  [card]=await projectRelease(job(),f.api,config);
  expect(card?.html).toContain('Health Check ✅');expect(card?.html).toContain('проверена успешно');
});
test('backend ignores unrelated jobs and frontend-only publication',async()=>{
  const f=fixture();const d=job();const p=JSON.parse(new TextDecoder().decode(d.raw));p.workflow_job.name='test';d.raw=new TextEncoder().encode(JSON.stringify(p));
  expect(await projectRelease(d,f.api,config)).toEqual([]);
  const d2=status();const p2=JSON.parse(new TextDecoder().decode(d2.raw));p2.deployment.environment='release-artifacts';d2.raw=new TextEncoder().encode(JSON.stringify(p2));
  expect(await projectRelease(d2,f.api,config)).toEqual([]);
});
test('backend rollback labels removed changes and enrichment failure still gives result',async()=>{
  const f=fixture();f.operation.kind='rollback';
  let [card]=await projectRelease(status(),f.api,config);expect(card?.html).toContain('Снимаемые изменения');
  f.api.changes=async()=>{throw new Error('unavailable')};
  [card]=await projectRelease(status(),f.api,config);expect(card?.html).toContain('Health Check ✅');expect(card?.html).toContain('неполные');
});
test('backend result guard rechecks Deployment and attempt before sending',async()=>{
 const {checkReleaseNotice}=await import('../src/releases');const f=fixture();
 const card=(await projectRelease(status(),f.api,config))[0]!;
 f.api.operation=async()=>{throw new Error('http_403')};
 expect(await checkReleaseNotice(card.release!,f.api)).toBe('retry');
});
for(const conclusion of ['failure','cancelled'] as const) test(`completed ${conclusion} job fallback sends while Deployment stays in_progress`,async()=>{
 const {checkReleaseNotice}=await import('../src/releases');const f=fixture();f.operation.state='in_progress';f.job.operation=f.operation;f.job.conclusion=conclusion;
 f.job.run.steps=[{name:'Switch backend',outcome:'success'},{name:'Health check',outcome:'failure'},{name:'Record final Deployment status',outcome:'failure'}];
 const d=job();const payload=JSON.parse(new TextDecoder().decode(d.raw));payload.workflow_job.conclusion=conclusion;d.raw=new TextEncoder().encode(JSON.stringify(payload));
 const [card]=await projectRelease(d,f.api,config);expect(card?.release?.kind).toBe('job-error');expect(card?.html).toContain('Health Check ⚪');
 expect(await checkReleaseNotice(card!.release!,f.api,config)).toBe('send');
});
