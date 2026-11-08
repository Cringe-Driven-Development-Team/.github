import {expect, test} from 'bun:test';
import {loadRelease, dispatchAndWait, extractRelease, SOURCE, INFRA} from '../.github/scripts/auxiliary-cd';
const sha = 'a'.repeat(40);
const release = {service:'webhook-alerts', image_ref:`ghcr.io/cringe-driven-development-team/webhook-alerts@sha256:${'b'.repeat(64)}`, source_sha:sha, publisher_run_id:12, publisher_run_attempt:2};
const run = {id:12, run_attempt:2, name:'Webhook alerts image', path:'.github/workflows/webhook-alerts-image.yml', event:'push', conclusion:'success', head_branch:'main', head_sha:sha, repository:{full_name:SOURCE}, head_repository:{full_name:SOURCE}};
const zip = (value=release, filename='release.json') => Bun.spawnSync(['python3','-c','import sys,zipfile,io; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); z.writestr(sys.argv[1],sys.argv[2]); z.close(); sys.stdout.buffer.write(b.getvalue())',filename,JSON.stringify(value)]).stdout;
const artifact = {id:7,name:'release-webhook-alerts-2',size_in_bytes:500,expired:false};
function sourceApi(artifacts:any[]=[artifact], value:any=release) {return async (path:string) => path.includes('/artifacts?') ? Response.json({total_count:artifacts.length,artifacts}) : new Response(zip(value));}
test('loads successful independent webhook release',async()=>expect(await loadRelease(run,sourceApi())).toEqual(release));
for(const patch of [{event:'pull_request'},{head_branch:'feature'},{conclusion:'failure'},{run_attempt:0},{name:'GitHubBot image'},{path:'.github/workflows/wrong.yml'},{repository:{full_name:'evil/repo'}},{head_repository:{full_name:'evil/repo'}}]) test(`rejects publisher ${JSON.stringify(patch)}`,async()=>{await expect(loadRelease({...run,...patch},sourceApi())).rejects.toThrow();});
for(const artifacts of [[],[artifact,artifact],[{...artifact,size_in_bytes:100000}],[{...artifact,expired:true}],[{...artifact,name:'release-webhook-alerts-1'}]]) test('rejects absent/ambiguous/oversized/expired/wrong attempt artifacts',async()=>{await expect(loadRelease(run,sourceApi(artifacts))).rejects.toThrow();});
for(const patch of [{publisher_run_attempt:1},{publisher_run_id:13},{source_sha:'b'.repeat(40)},{service:'githubbot'},{image_ref:'evil@sha256:x'},{extra:1}]) test(`rejects release mismatch ${JSON.stringify(patch)}`,async()=>{await expect(loadRelease(run,sourceApi([artifact],{...release,...patch}))).rejects.toThrow();});
test('ZIP rejects other filenames and oversized uncompressed JSON',()=>{expect(()=>extractRelease(zip(release,'other.json'))).toThrow(); expect(()=>extractRelease(zip({...release,extra:'x'.repeat(17000)}))).toThrow();});
function fixture(id=44, conclusion:any='success', service='webhook-alerts') {let now=0; const calls:any[]=[]; const requestId=`${service}:12:2:30:1`; const remote={id,html_url:`https://github.com/${INFRA}/actions/runs/${id}`,repository:{full_name:INFRA},path:'.github/workflows/auxiliary-deploy.yml',event:'workflow_dispatch',head_branch:'main',display_title:`VPS3 ${requestId}`,status:'completed',conclusion}; return {requestId,calls,remote,clock:{now:()=>now,sleep:async(ms:number)=>{now+=ms;}},api:async(path:string,init?:RequestInit)=>{calls.push([path,init]);return Response.json(init?.method==='POST'?{workflow_run_id:id,run_url:`https://api.github.com/repos/${INFRA}/actions/runs/${id}`,html_url:remote.html_url}:remote);}};}
test('concurrent independent services wait their distinct exact run IDs',async()=>{
 await Promise.all((['githubbot','webhook-alerts'] as const).map(async(service,index)=>{
  const id=44+index;const f=fixture(id,'success',service);
  const input={...release,service,image_ref:`ghcr.io/cringe-driven-development-team/${service}@sha256:${'b'.repeat(64)}`};
  expect(await dispatchAndWait(input,f.requestId,f.api,f.clock)).toEqual({run_id:id,html_url:f.remote.html_url});
  expect(f.calls[1][0]).toEndWith(`/actions/runs/${id}`);
  expect(JSON.parse(f.calls[0][1].body)).toEqual({ref:'main',inputs:{operation:'deploy',service,image_ref:input.image_ref,source_sha:sha,request_id:f.requestId}});
 }));
});
for(const conclusion of ['failure','cancelled','timed_out','neutral',null]) test(`terminal ${conclusion} fails`,async()=>{const f=fixture(44,conclusion);await expect(dispatchAndWait(release,f.requestId,f.api,f.clock)).rejects.toThrow();});
for(const status of [204,401,403]) test(`HTTP ${status} fails protocol/auth`,async()=>{const f=fixture();await expect(dispatchAndWait(release,f.requestId,async()=>new Response(null,{status}),f.clock)).rejects.toThrow();});
test('network errors fail without dispatch retry',async()=>{const f=fixture();let calls=0;await expect(dispatchAndWait(release,f.requestId,async()=>{calls++;throw Error('network');},f.clock)).rejects.toThrow();expect(calls).toBe(1);});
test('deadline expires and rate limits honor retry-after',async()=>{const f=fixture();let calls=0;await expect(dispatchAndWait(release,f.requestId,async()=>{calls++;return new Response(null,{status:429,headers:{'retry-after':'3600'}});},f.clock)).rejects.toThrow(/deadline/);expect(calls).toBe(2);});
for(const patch of [{repository:{full_name:'evil/repo'}},{path:'wrong'},{event:'push'},{head_branch:'other'},{display_title:'VPS3 other'},{id:99}]) test('rejects wrong remote identity',async()=>{const f=fixture();const api=async(path:string,init?:RequestInit)=>init?.method==='POST'?f.api(path,init):Response.json({...f.remote,...patch});await expect(dispatchAndWait(release,f.requestId,api,f.clock)).rejects.toThrow();});
test('unfinished remote run exhausts deadline',async()=>{const f=fixture();const api=async(path:string,init?:RequestInit)=>init?.method==='POST'?f.api(path,init):Response.json({...f.remote,status:'queued',conclusion:null});await expect(dispatchAndWait(release,f.requestId,api,f.clock)).rejects.toThrow(/deadline/);});

test('workflow trusts only main and scopes tokens/job timeout',async()=>{
 const {readFileSync}=await import('node:fs');
 const w:any=Bun.YAML.parse(readFileSync(new URL('../.github/workflows/auxiliary-cd.yml',import.meta.url),'utf8'));
 expect(w.on.workflow_run).toEqual({workflows:['GitHubBot image','Webhook alerts image'],types:['completed'],branches:['main']});
 expect(w.permissions).toEqual({contents:'read',actions:'read'});
 expect(w.jobs.deploy['timeout-minutes']).toBe(130);
 expect(w.jobs.deploy.if).toContain("github.event.workflow_run.conclusion == 'success'");
 expect(w.jobs.deploy.if).toContain("github.event.workflow_run.event == 'push'");
 expect(w.jobs.deploy.steps[0].with).toEqual({ref:'main','persist-credentials':false});
 expect(w.jobs.deploy.steps.at(-1).env.AUXILIARY_DEPLOY_TOKEN).toBe('${{ secrets.AUXILIARY_DEPLOY_TOKEN }}');
});

test('actual streamed ZIP cap applies even if artifact metadata lies',async()=>{
 const api=async(path:string)=>path.includes('/artifacts?')?Response.json({total_count:1,artifacts:[artifact]}):new Response(new Uint8Array(32769));
 await expect(loadRelease(run,api)).rejects.toThrow(/too large/);
});
test('malformed ZIP fails closed',()=>expect(()=>extractRelease(new Uint8Array([1,2,3]))).toThrow());
test('successful rate-limit retry waits Retry-After before polling exact run',async()=>{
 const f=fixture();let calls=0;
 const api=async(path:string,init?:RequestInit)=>{calls++;return calls===2?new Response(null,{status:429,headers:{'retry-after':'20'}}):f.api(path,init);};
 expect((await dispatchAndWait(release,f.requestId,api,f.clock)).run_id).toBe(44);
 expect(f.clock.now()).toBe(20000);
 expect(calls).toBe(3);
});
for(const status of [401,403])test(`poll HTTP ${status} fails`,async()=>{
 const f=fixture();const api=async(path:string,init?:RequestInit)=>init?.method==='POST'?f.api(path,init):new Response(null,{status});
 await expect(dispatchAndWait(release,f.requestId,api,f.clock)).rejects.toThrow();
});
test('poll network error does not redispatch',async()=>{
 const f=fixture();let posts=0;const api=async(path:string,init?:RequestInit)=>{if(init?.method==='POST'){posts++;return f.api(path,init);}throw Error('network');};
 await expect(dispatchAndWait(release,f.requestId,api,f.clock)).rejects.toThrow('network');expect(posts).toBe(1);
});
test('invalid dispatch response URL fails without polling',async()=>{
 const f=fixture();await expect(dispatchAndWait(release,f.requestId,async()=>Response.json({workflow_run_id:44,run_url:'https://evil/',html_url:f.remote.html_url}),f.clock)).rejects.toThrow(/protocol/);
});

for(const failure of ['failure','cancelled','auth','network','timeout'])test(`validated deployment URL survives ${failure} in caller summary`,async()=>{
 const f=fixture();let summary='',posts=0;
 const api=async(path:string,init?:RequestInit)=>{
  if(init?.method==='POST'){posts++;return f.api(path,init);}
  expect(summary).toContain(`Deployment: ${f.remote.html_url}`);
  if(failure==='auth')return new Response(null,{status:401});
  if(failure==='network')throw Error('network');
  return Response.json({...f.remote,status:failure==='timeout'?'queued':'completed',conclusion:failure});
 };
 await expect(dispatchAndWait(release,f.requestId,api,f.clock,url=>{summary+=`\nDeployment: ${url}\n`;})).rejects.toThrow();
 expect(summary).toBe(`\nDeployment: ${f.remote.html_url}\n`);
 expect(posts).toBe(1);
});
test('invalid dispatch URL is never reported to caller summary',async()=>{
 const f=fixture();let reported=false;
 await expect(dispatchAndWait(release,f.requestId,async()=>Response.json({workflow_run_id:44,run_url:'https://evil/',html_url:f.remote.html_url}),f.clock,()=>{reported=true;})).rejects.toThrow(/protocol/);
 expect(reported).toBe(false);
});

// Live GETs at 353/738ms had default title; at 1176ms the queued run had its request title.
test('queued default workflow title becomes request title before success',async()=>{
 const f=fixture();let polls=0,posts=0,reported='';
 const states=[
  {display_title:'Auxiliary deploy',status:'queued',conclusion:null},
  {display_title:'Auxiliary deploy',status:'queued',conclusion:null},
  {display_title:f.remote.display_title,status:'queued',conclusion:null},
  {display_title:f.remote.display_title,status:'completed',conclusion:'success'},
 ];
 const api=async(path:string,init?:RequestInit)=>{
  if(init?.method==='POST'){posts++;return f.api(path,init);}
  expect(path).toEndWith('/actions/runs/44');
  return Response.json({...f.remote,...states[polls++]});
 };
 expect(await dispatchAndWait(release,f.requestId,api,f.clock,url=>{reported=url;})).toEqual({run_id:44,html_url:f.remote.html_url});
 expect(posts).toBe(1);expect(polls).toBe(4);expect(f.clock.now()).toBe(45000);expect(reported).toBe(f.remote.html_url);
});
for(const patch of [
 {display_title:'unrelated title'},
 {repository:{full_name:'evil/repo'}},
 {path:'wrong'},
 {id:99},
 {html_url:'https://evil/'},
 {event:'push'},
 {head_branch:'other'},
 {status:'in_progress'},
 {status:'completed',conclusion:'success'},
])test(`queued default title never weakens identity/status checks: ${JSON.stringify(patch)}`,async()=>{
 const f=fixture();let posts=0,polls=0;
 const api=async(path:string,init?:RequestInit)=>{
  if(init?.method==='POST'){posts++;return f.api(path,init);}
  polls++;return Response.json({...f.remote,display_title:'Auxiliary deploy',status:'queued',conclusion:null,...patch});
 };
 await expect(dispatchAndWait(release,f.requestId,api,f.clock)).rejects.toThrow('Unexpected deployment run identity');
 expect(posts).toBe(1);expect(polls).toBe(1);expect(f.clock.now()).toBe(0);
});
test('queued default title that never populates reaches existing deadline',async()=>{
 const f=fixture();let posts=0,polls=0,reported='';
 const api=async(path:string,init?:RequestInit)=>{
  if(init?.method==='POST'){posts++;return f.api(path,init);}
  polls++;return Response.json({...f.remote,display_title:'Auxiliary deploy',status:'queued',conclusion:null});
 };
 await expect(dispatchAndWait(release,f.requestId,api,f.clock,url=>{reported=url;})).rejects.toThrow(/deadline/);
 expect(posts).toBe(1);expect(polls).toBe(480);expect(f.clock.now()).toBe(7200000);expect(reported).toBe(f.remote.html_url);
});
