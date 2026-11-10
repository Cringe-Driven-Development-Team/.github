import {expect,test} from 'bun:test';
import {loadConfig} from '../src/config';
import {startService} from '../src/main';
import {openStore} from '../src/store';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
const env={GITHUB_WEBHOOK_SECRET:'test',APIDOG_SIGNATURE_KEY:'test',APIDOG_SIGNATURE_HEADER:'X-Test'};
test('backend topic is separate and requires a GitHub reading token',()=>{
 expect(loadConfig({...env,TELEGRAM_RELEASES_TOPIC_ID:'99',TELEGRAM_BACKEND_RELEASES_TOPIC_ID:'3377',GITHUB_API_TOKEN:'test'})).toMatchObject({releasesTopic:99,backendReleasesTopic:3377});
 for(const value of ['0','-1','oops','9007199254740992'])expect(()=>loadConfig({...env,TELEGRAM_BACKEND_RELEASES_TOPIC_ID:value,GITHUB_API_TOKEN:'test'})).toThrow();
 expect(()=>loadConfig({...env,TELEGRAM_BACKEND_RELEASES_TOPIC_ID:'3377'})).toThrow('GITHUB_API_TOKEN');
});
test('activated backend fails startup if its topic has disappeared without affecting frontend cutoff',()=>{
 const dir=mkdtempSync(join(tmpdir(),'backend-config-'));const path=join(dir,'queue.sqlite');
 try{const s=openStore(path);s.activateReleases(100,'Cringe-Driven-Development-Team/backend');s.close();
  expect(()=>startService(loadConfig({...env,DATABASE_PATH:path,GITHUB_API_TOKEN:'test'}))).toThrow('backend');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('backend activation CLI persists an independent cutoff and never prints the API token',()=>{
 const dir=mkdtempSync(join(tmpdir(),'backend-cli-'));const path=join(dir,'queue.sqlite');
 try{
  const s=openStore(path);s.activateReleases(100);s.close();
  const run=Bun.spawnSync([process.execPath,'run',new URL('../src/cli.ts',import.meta.url).pathname,'backend-release-activate','2020-01-01T00:00:00Z'],
   {env:{...process.env,DATABASE_PATH:path,TELEGRAM_BACKEND_RELEASES_TOPIC_ID:'3377',GITHUB_API_TOKEN:'synthetic-never-print'}});
  expect(run.exitCode).toBe(0);expect(new TextDecoder().decode(run.stdout)+new TextDecoder().decode(run.stderr)).not.toContain('synthetic-never-print');
  const reopened=openStore(path);try{expect(reopened.releaseActivation()).toBe(100);expect(reopened.releaseActivation('Cringe-Driven-Development-Team/backend')).toBe(1577836800000)}finally{reopened.close()}
 }finally{rmSync(dir,{recursive:true,force:true})}
});
