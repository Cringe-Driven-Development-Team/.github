import {appendFileSync, readFileSync} from 'node:fs';

export const SOURCE = 'Cringe-Driven-Development-Team/.github';
export const INFRA = 'Cringe-Driven-Development-Team/infra';
const workflow = 'auxiliary-deploy.yml';
const maxZip = 32768;
export type Release = {service:'githubbot'|'webhook-alerts';image_ref:string;source_sha:string;publisher_run_id:number;publisher_run_attempt:number};
export type PublisherRun = {id:number;run_attempt:number;name:string;path:string;event:string;conclusion:string;head_branch:string;head_sha:string;repository:{full_name:string};head_repository:{full_name:string}};
type Api = (path:string, init?:RequestInit)=>Promise<Response>;
type Clock = {now:()=>number;sleep:(ms:number)=>Promise<void>};
const positive = (value:unknown) => Number.isSafeInteger(value) && Number(value)>0;
function validateRelease(value:any): asserts value is Release {
  if (!value || Object.keys(value).sort().join(',') !== 'image_ref,publisher_run_attempt,publisher_run_id,service,source_sha' || !['githubbot','webhook-alerts'].includes(value.service) || !new RegExp(`^ghcr.io/cringe-driven-development-team/${value.service}@sha256:[a-f0-9]{64}$`).test(value.image_ref) || !/^[a-f0-9]{40}$/.test(value.source_sha) || !positive(value.publisher_run_id) || !positive(value.publisher_run_attempt)) throw Error('Invalid Release fields');
}
export function extractRelease(zip:Uint8Array): unknown {
  if(zip.length>maxZip) throw Error('Release ZIP too large');
  const result = Bun.spawnSync(['python3','-c',`import io,sys,zipfile
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
n=z.infolist()
assert len(n)==1 and n[0].filename=='release.json', 'Expected only release.json'
a=n[0]
assert not a.flag_bits & 1 and a.file_size<=16384, 'Invalid release.json size/encryption'
with z.open(a) as f:
 b=f.read(16385)
 assert len(b)<=16384, 'release.json too large'
sys.stdout.buffer.write(b)
`],{stdin:zip});
  if(result.exitCode!==0) throw Error('Invalid Release ZIP (requires python3 zipfile)');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result.stdout));
}
async function boundedBytes(response:Response):Promise<Uint8Array> {
  const reader=response.body?.getReader(); if(!reader) throw Error('Missing artifact body');
  const parts:Uint8Array[]=[];let size=0;
  try {while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maxZip)throw Error('Release ZIP too large');parts.push(value);}} finally {await reader.cancel();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}
async function json(response:Response) {if(!response.ok)throw Error(`GitHub API HTTP ${response.status}`);return response.json();}
export async function loadRelease(run:PublisherRun,api:Api):Promise<Release> {
  const service=run.name==='GitHubBot image'?'githubbot':run.name==='Webhook alerts image'?'webhook-alerts':null;
  if(!service || run.repository?.full_name!==SOURCE || run.head_repository?.full_name!==SOURCE || run.event!=='push' || run.conclusion!=='success' || run.head_branch!=='main' || run.path!==`.github/workflows/${service}-image.yml` || !positive(run.id) || !positive(run.run_attempt) || !/^[a-f0-9]{40}$/.test(run.head_sha))throw Error('Untrusted publisher run');
  const listing=await json(await api(`/repos/${SOURCE}/actions/runs/${run.id}/artifacts?per_page=100`));
  if(listing.total_count>100 || !Array.isArray(listing.artifacts))throw Error('Invalid artifact listing');
  const matches=listing.artifacts.filter((a:any)=>a.name===`release-${service}-${run.run_attempt}`);
  if(matches.length!==1)throw Error('Expected exactly one release artifact for publisher attempt');
  const artifact=matches[0];
  if(artifact.expired!==false || !positive(artifact.id) || !positive(artifact.size_in_bytes) || artifact.size_in_bytes>maxZip)throw Error('Expired or oversized release artifact');
  const response=await api(`/repos/${SOURCE}/actions/artifacts/${artifact.id}/zip`);if(!response.ok)throw Error(`Artifact HTTP ${response.status}`);
  const release=extractRelease(await boundedBytes(response));validateRelease(release);
  if(release.service!==service || release.publisher_run_id!==run.id || release.publisher_run_attempt!==run.run_attempt || release.source_sha!==run.head_sha)throw Error('Release does not match publisher event');
  return release;
}
export async function dispatchAndWait(release:Release,requestId:string,api:Api,clock:Clock,onDispatched?:(url:string)=>void):Promise<{run_id:number;html_url:string}> {
  validateRelease(release);
  const prefix=`${release.service}:${release.publisher_run_id}:${release.publisher_run_attempt}:`;
  if(!requestId.startsWith(prefix) || !/^[a-z-]+:[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*$/.test(requestId))throw Error('Invalid request_id');
  const deadline=clock.now()+120*60*1000;
  async function request(path:string,init?:RequestInit):Promise<Response>{
    while(clock.now()<deadline){
      const response=await api(path,init);
      if(clock.now()>=deadline)throw Error('Deployment deadline exceeded');
      const retry=response.headers.get('retry-after');
      if((response.status===429 || response.status===403) && retry!==null){
        const seconds=Number(retry);const delay=Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-clock.now();
        if(!Number.isFinite(delay)||delay<=0)throw Error('Invalid Retry-After');
        await clock.sleep(Math.min(delay,deadline-clock.now()));continue;
      }
      return response;
    }throw Error('Deployment deadline exceeded');
  }
  const dispatched=await request(`/repos/${INFRA}/actions/workflows/${workflow}/dispatches`,{method:'POST',body:JSON.stringify({ref:'main',inputs:{operation:'deploy',service:release.service,image_ref:release.image_ref,source_sha:release.source_sha,request_id:requestId}})});
  if(dispatched.status!==200)throw Error(`Dispatch protocol: expected HTTP 200 with run ID, got ${dispatched.status}`);
  const data=await dispatched.json();
  const id=data.workflow_run_id;
  const url=`https://github.com/${INFRA}/actions/runs/${id}`;
  if(!positive(id) || data.run_url!==`https://api.github.com/repos/${INFRA}/actions/runs/${id}` || data.html_url!==url)throw Error('Dispatch protocol: missing/invalid workflow_run_id or URLs');
  onDispatched?.(url);
  while(clock.now()<deadline){
    const run=await json(await request(`/repos/${INFRA}/actions/runs/${id}`));
    if(run.id!==id || run.repository?.full_name!==INFRA || run.path!==`.github/workflows/${workflow}` || run.event!=='workflow_dispatch' || run.head_branch!=='main' || run.display_title!==`VPS3 ${requestId}` || run.html_url!==url)throw Error('Unexpected deployment run identity');
    if(run.status==='completed'){if(run.conclusion!=='success')throw Error(`Deployment ${url} concluded ${run.conclusion}`);return {run_id:id,html_url:url};}
    await clock.sleep(Math.min(15000,deadline-clock.now()));
  }throw Error(`Deployment deadline exceeded: ${url}`);
}
function api(token:string):Api {
  if(!token)throw Error('Missing GitHub API token');
  return (path,init)=>fetch(`https://api.github.com${path}`,{...init,signal:AbortSignal.timeout(60000),headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2026-03-10','Content-Type':'application/json'}});
}
if(import.meta.main){
  try{
    const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!,'utf8'));
    if(process.env.GITHUB_REPOSITORY!==SOURCE || process.env.GITHUB_EVENT_NAME!=='workflow_run' || event.action!=='completed')throw Error('Untrusted caller event');
    const release=await loadRelease(event.workflow_run,api(process.env.GITHUB_TOKEN!));
    const callerId=process.env.GITHUB_RUN_ID, attempt=process.env.GITHUB_RUN_ATTEMPT;
    const requestId=`${release.service}:${release.publisher_run_id}:${release.publisher_run_attempt}:${callerId}:${attempt}`;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY!,`Publisher: https://github.com/${SOURCE}/actions/runs/${release.publisher_run_id}\n\nRequest: \`${requestId}\`\n`);
    await dispatchAndWait(release,requestId,api(process.env.AUXILIARY_DEPLOY_TOKEN!),{now:Date.now,sleep:ms=>Bun.sleep(ms)},
      url=>appendFileSync(process.env.GITHUB_STEP_SUMMARY!,`\nDeployment: ${url}\n`));
  }catch(error){console.error(error instanceof Error?error.message:'Auxiliary CD failed');process.exitCode=1;}
}
