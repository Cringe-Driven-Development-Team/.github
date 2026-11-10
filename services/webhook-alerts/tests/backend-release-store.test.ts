import {expect,test} from 'bun:test';
import {openStore,type OutgoingMessage} from '../src/store';
const backend='Cringe-Driven-Development-Team/backend',frontend='Cringe-Driven-Development-Team/frontend';
function accept(s:ReturnType<typeof openStore>,repo=backend,id='one',at=1000){s.accept({source:'github',event:'workflow_job',deliveryId:id,receivedAt:at,raw:new TextEncoder().encode(JSON.stringify({repository:{full_name:repo},action:'completed'}))});}
test('backend activation is independent and preserves frontend cutoff',()=>{
  const s=openStore(':memory:');try{
    s.activateReleases(100);accept(s);accept(s,frontend,'front');
    expect(s.claimUnprepared(1000,100,'release-operation').map(d=>d.deliveryId)).toEqual(['front']);
    s.activateReleases(500,backend);expect(s.releaseActivation()).toBe(100);expect(s.releaseActivation(backend)).toBe(500);
    expect(s.claimUnprepared(1101,100,'release-operation').map(d=>d.deliveryId)).toEqual(['one','front']);
    expect(()=>s.activateReleases(501,backend)).toThrow();
  }finally{s.close()}
});
const fallback:OutgoingMessage={topic:3377,html:'unknown',release:{kind:'job-error',key:`result:${backend}:deploy:10:1`,repository:backend,runId:10,attempt:1,jobId:100}};
const result:OutgoingMessage={topic:3377,html:'confirmed',release:{kind:'result',key:fallback.release!.key,repository:backend,runId:10,deploymentId:2}};
for(const order of ['fallback-first','status-first'])test(`backend ${order} sends one terminal result`,()=>{
 const s=openStore(':memory:');try{
  s.activateReleases(500,backend);accept(s,backend,'first');accept(s,backend,'second');
  const ds=s.claimUnprepared(1000,100,'release-operation');
  s.prepare(ds[0]!.id,[order==='fallback-first'?fallback:result]);s.prepare(ds[1]!.id,[order==='fallback-first'?result:fallback]);
  const due=s.claimDue(1000,100);expect(due).toHaveLength(1);expect(due[0]!.html).toBe('confirmed');
 }finally{s.close()}
});
test('backend terminal status does not repeat a started or uncertain fallback',()=>{
 const s=openStore(':memory:');try{
  s.activateReleases(500,backend);accept(s);s.prepare(s.claimUnprepared(1000,100,'release-operation')[0]!.id,[fallback]);
  const row=s.claimDue(1000,100)[0]!;expect(s.beginReleaseSend(row.id,1000)).toBe(true);s.markFailed(row.id,'release_uncertain');
  accept(s,backend,'later');s.prepare(s.claimUnprepared(1101,100,'release-operation')[0]!.id,[result]);
  expect(s.claimDue(2000,100)).toHaveLength(0);
 }finally{s.close()}
});
test('backend activation does not replay old events or mark frontend history prepared',()=>{
 const s=openStore(':memory:');try{
  accept(s,backend,'old',10);accept(s,frontend,'front',10);s.activateReleases(500,backend);
  s.activateReleases(0);expect(s.claimUnprepared(1000,100,'release-operation').map(d=>d.deliveryId)).toEqual(['front']);
 }finally{s.close()}
});
test('migration from v3 keeps frontend activation and uncertain outbox',async()=>{
 const {Database}=await import('bun:sqlite');const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'backend-v3-'));const path=join(dir,'queue.sqlite');
 try{
  const original=openStore(path);original.activateReleases(100);accept(original,frontend);
  original.prepare(original.claimUnprepared(1000,100,'release-operation')[0]!.id,[fallback]);
  const row=original.claimDue(1000,100)[0]!;original.beginReleaseSend(row.id,1000);original.markFailed(row.id,'release_uncertain');original.close();
  const db=new Database(path);db.exec('DROP TABLE backend_release_activation; DROP TABLE release_contract; PRAGMA user_version=3');db.close();
  const migrated=openStore(path);try{expect(migrated.releaseActivation()).toBe(100);expect(migrated.releaseActivation(backend)).toBeNull();expect(migrated.claimDue(1000000,100)).toHaveLength(0)}finally{migrated.close()}
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('terminal result discovered by send guard replaces unsent fallback before delivery',async()=>{
 const {releaseFixture}=await import('./helpers/release');const {checkReleaseNotice}=await import('../src/releases');const {deliverOnce}=await import('../src/worker');
 const f=releaseFixture();f.operation.state='failure';f.operation.run.workflow='CI';f.operation.run.event='push';
 f.operation.run.url=`https://github.com/${backend}/actions/runs/10`;f.operation.notification.report_url=f.operation.run.url+'#summary';
 f.operation.imageRef=`ghcr.io/cringe-driven-development-team/backend@sha256:${'d'.repeat(64)}`;
 f.operation.run.steps=[{name:'Switch backend',outcome:'success'},{name:'Health check',outcome:'failure'}];f.job.operation=f.operation;
 const s=openStore(':memory:');try{
  s.activateReleases(500,backend);accept(s);s.prepare(s.claimUnprepared(1000,100,'release-operation')[0]!.id,[fallback]);
  const sent:string[]=[];
  await deliverOnce({store:s,now:1000,send:async m=>{sent.push(m.html);return {kind:'sent',telegramMessageId:1}},beforeReleaseSend:n=>checkReleaseNotice(n,f.api,{topic:3377,siteUrl:'https://cellestial.ru',repository:backend})});
  expect(sent).toHaveLength(1);expect(sent[0]).toContain('Health Check ❌');
  accept(s,backend,'later');s.prepare(s.claimUnprepared(1200,100,'release-operation')[0]!.id,[result]);expect(s.claimDue(2000,100)).toHaveLength(0);
 }finally{s.close()}
});
test('main schema v4 upgrades without losing frontend contract activation or outbox',async()=>{
 const {Database}=await import('bun:sqlite');const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'backend-main-v4-'));const path=join(dir,'queue.sqlite');
 try{
  const initial=openStore(path);initial.activateReleases(100);accept(initial,frontend);initial.prepare(initial.claimUnprepared(1000,100,'release-operation')[0]!.id,[fallback]);initial.close();
  const db=new Database(path);db.exec('DROP TABLE IF EXISTS backend_release_activation; CREATE TABLE IF NOT EXISTS release_contract (id INTEGER PRIMARY KEY CHECK(id=1), cutoff_ms INTEGER NOT NULL); INSERT INTO release_contract VALUES(1,200); PRAGMA user_version=4');db.close();
  const migrated=openStore(path);try{
   expect(migrated.releaseActivation()).toBe(100);expect(migrated.releaseContract()).toBe(200);expect(migrated.releaseActivation(backend)).toBeNull();
   migrated.activateReleases(500,backend);expect(migrated.releaseActivation(backend)).toBe(500);expect(migrated.claimDue(1000,100)).toHaveLength(1);
  }finally{migrated.close()}
 }finally{rmSync(dir,{recursive:true,force:true})}
});
