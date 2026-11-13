import standalone from './fixtures/github/backend-cd-contract.json';
import {expect,test} from 'bun:test';
import {backendApiFixture,A,B,C} from './helpers/backend';
test('backend push CI production needs no frontend assets or release-artifacts', async () => {
  const {api,state} = backendApiFixture();
  const op = await api.operation(2);
  expect(op.kind).toBe('deploy'); expect(op.sha).toBe(B); expect(op.run.workflow).toBe('CI');
  expect(op.run.steps?.map(s=>s.name)).toEqual(['Switch backend','Health check']);
  expect(state.calls.some(p=>p.includes('release-artifacts'))).toBe(false);
});
for (const invalid of ['image','ref','head','creator','attempt','report','event']) test(`backend rejects ${invalid}`, async()=>{
  const {api,state} = backendApiFixture();
  if(invalid==='image') state.current.payload.image_ref = state.current.payload.image_ref.replace('/backend@','/bff@');
  if(invalid==='ref') state.current.ref = C;
  if(invalid==='head') state.head = C;
  if(invalid==='creator') state.current.creator.login='someone';
  if(invalid==='attempt') state.current.payload.notification.run_attempt=0;
  if(invalid==='report') state.current.payload.notification.report_url='https://evil.invalid/';
  if(invalid==='event') state.event='workflow_dispatch';
  await expect(api.operation(2)).rejects.toThrow();
});
test('backend rollback permits different workflow head only for saved successful digest', async()=>{
  const {api,state} = backendApiFixture(); state.current.task='rollback';state.current.payload.action='rollback';
  state.current.sha=A;state.current.ref=A;state.workflow='rollback';state.event='workflow_dispatch';state.head=C;state.jobName='rollback / deploy';
  expect((await api.operation(2)).sha).toBe(A);
  state.previous.payload.image_ref = state.previous.payload.image_ref.replace('d'.repeat(64),'e'.repeat(64));
  await expect(api.operation(2)).rejects.toThrow();
});
test('backend fallback verifies reusable job and ignores unrelated jobs', async()=>{
  const {api,state} = backendApiFixture();state.history=[];
  expect((await api.job(200)).operation).toBeNull();
  state.jobName='test';await expect(api.job(200)).rejects.toThrow();
});
test('backend rerun reads the exact attempt and never combines attempt 1 evidence',async()=>{
 const {api,state}=backendApiFixture();state.attempt=2;state.current.payload.notification.run_attempt=2;
 const op=await api.operation(2);expect(op.run.attempt).toBe(2);
 expect(state.calls.some(p=>p.includes('/runs/20/attempts/2'))).toBe(true);
 expect(state.calls.some(p=>p.includes('/runs/20/attempts/1'))).toBe(false);
});
test('backend rollback rejects different successful digests for the same target SHA',async()=>{
 const {api,state}=backendApiFixture();state.current.task='rollback';state.current.payload.action='rollback';state.current.sha=A;state.current.ref=A;
 state.workflow='rollback';state.event='workflow_dispatch';state.head=C;state.jobName='rollback / deploy';
 state.history.push({...state.previous,id:3,payload:{...state.previous.payload,image_ref:state.previous.payload.image_ref.replace('d'.repeat(64),'e'.repeat(64))}});
 await expect(api.operation(2)).rejects.toThrow('untrusted_rollback_target');
});
test('backend terminal status requires the production job and readable Jobs API',async()=>{
 const {api,state}=backendApiFixture();state.jobName='test';await expect(api.operation(2)).rejects.toThrow();
 state.jobName='deploy / deploy';state.extra=url=>url.pathname.endsWith('/jobs')?new Response('',{status:403}):undefined;
 await expect(api.operation(2)).rejects.toThrow('http_403');
});

test('standalone backend CD verifies the deployment SHA independently of dispatch HEAD', async () => {
  const {api,state} = backendApiFixture();
  state.workflow='cd';state.event='workflow_dispatch';state.head=C;state.jobName='deploy';
  Object.assign(state.current, standalone.deployment);
  const op=await api.operation(2);
  expect(op.sha).toBe(standalone.deployment.sha);expect(op.run.workflow).toBe('CD');expect(op.run.headSha).toBe(standalone.run.head_sha);
  expect((await api.job(200)).run.workflow).toBe('CD');
  state.event='push';await expect(api.operation(2)).rejects.toThrow('untrusted_run');
});
