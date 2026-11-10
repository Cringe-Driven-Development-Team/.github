import {expect,test} from 'bun:test';
import {checkBackendReleaseAccess} from '../src/release-preflight';
test('backend preflight checks read endpoints and never writes or exposes the token',async()=>{
 const calls:string[]=[];const fetcher=(async(input,init)=>{expect(init?.method??'GET').toBe('GET');calls.push(String(input));return Response.json([])}) as typeof fetch;
 await checkBackendReleaseAccess('secret-test',fetcher);
 expect(calls.some(p=>p.includes('/actions/runs'))).toBe(true);expect(calls.some(p=>p.includes('/deployments'))).toBe(true);expect(calls.some(p=>p.includes('/contents/'))).toBe(true);
 await expect(checkBackendReleaseAccess('secret-test',(async()=>new Response('secret-test',{status:403})) as unknown as typeof fetch)).rejects.toThrow('http_403');
});
