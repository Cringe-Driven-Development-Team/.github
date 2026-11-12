import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHmac} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {openStore} from '../src/store';import {loadConfig} from '../src/config';import {startService} from '../src/main';
import {backendApiFixture,repo} from './helpers/backend';
test('signed backend webhook reaches its own topic and preserves outbox after restart without live Telegram',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'backend-worker-'));const path=join(dir,'queue.sqlite');
 const s=openStore(path);s.activateReleases(Date.now()-10000);s.activateReleases(Date.now()-10000,repo);s.close();
 const f=backendApiFixture();f.state.current.created_at=new Date().toISOString();
 const sent:Record<string,unknown>[]=[];
 const fetcher=(async(input,init)=>{
  const url=new URL(String(input));
  if(url.hostname==='api.telegram.org'){const body=JSON.parse(String(init?.body));sent.push(body);return Response.json({ok:true,result:{message_id:123}})}
  if(url.hostname==='api.apidog.com')return Response.json({success:true,data:[],meta:{nextPage:null}});
  if(url.pathname.includes('/compare/'))return Response.json({status:'ahead',total_commits:0,commits:[]});
  return f.fetcher(input,init);
 }) as typeof fetch;
 const config=loadConfig({DATABASE_PATH:path,GITHUB_WEBHOOK_SECRET:'test',GITHUB_API_TOKEN:'test',APIDOG_SIGNATURE_KEY:'test',APIDOG_SIGNATURE_HEADER:'X-Test',
  WEBHOOK_ALERTS_SEND_ENABLED:'true',TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'-1001',TELEGRAM_RELEASES_TOPIC_ID:'99',TELEGRAM_BACKEND_RELEASES_TOPIC_ID:'3377',TELEGRAM_USER_MAP:'{"GrayMouse9":"123456789"}',
  TELEGRAM_APIDOG_BOT_TOKEN:'fake',TELEGRAM_APIDOG_TOPIC_ID:'88',APIDOG_ACCESS_TOKEN:'fake',APIDOG_PROJECT_ID:'1',APIDOG_TARGET_BRANCH_ID:'2',
  APIDOG_PROJECT_NAME:'test',APIDOG_CONTRACT_URL:'https://example.test',APIDOG_TELEGRAM_USER_MAP:'{}',APIDOG_MR_REVIEWERS:'[{"name":"A","telegramId":"1"},{"name":"B","telegramId":"2"}]'});
 let service=startService(config,{fetch:fetcher});const db=new Database(path);
 async function post(id:string,event:string,payload:unknown){const raw=JSON.stringify({repository:{full_name:repo},...payload as object});return service.app.request('/webhooks/github',{method:'POST',body:raw,
 headers:{'Content-Type':'application/json','X-GitHub-Event':event,'X-GitHub-Delivery':id,'X-Hub-Signature-256':'sha256='+createHmac('sha256','test').update(raw).digest('hex')}})}
 const payload={action:'created',deployment:{id:2,environment:'production'},deployment_status:{state:'success'}};
 try{
  expect((await post('one','deployment_status',payload)).status).toBe(202);
  const until=Date.now()+4000;while(!sent.length&&Date.now()<until)await Bun.sleep(20);
  expect(sent).toHaveLength(1);expect(sent[0]!.message_thread_id).toBe(3377);expect(sent[0]!.link_preview_options).toEqual({is_disabled:true});expect(String(sent[0]!.text)).toContain('Health Check ✅');
  expect(sent[0]!.parse_mode).toBe('HTML');expect(String(sent[0]!.text)).toContain('Запустил: <a href="tg://user?id=123456789">GrayMouse9</a>');
  await service.stop();service=startService(config,{fetch:fetcher});
  expect((await post('two','deployment_status',payload)).status).toBe(202);
  expect((await post('job','workflow_job',{action:'completed',workflow_job:{id:200,name:'deploy / deploy',conclusion:'failure'}})).status).toBe(202);
  f.state.history=[f.state.current];
  await Bun.sleep(1200);expect(sent).toHaveLength(1);
  expect(db.query('SELECT COUNT(*) AS n FROM release_notices WHERE operation_key IS NOT NULL').get()).toEqual({n:1});
 }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true})}
},10000);
