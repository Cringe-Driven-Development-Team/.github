import contract from '../fixtures/github/backend-release-contract.json';
import { expect } from 'bun:test';
import { createReleaseApi } from '../../src/release-api';
export const repo = 'Cringe-Driven-Development-Team/backend';
export const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
export function backendApiFixture() {
  const current = structuredClone(contract.deployment), previous = structuredClone(contract.previous);
  const state = { current, previous, history: [previous], calls: [] as string[], workflow: 'ci', event: 'push', head: B,
    attempt: 1, jobName: 'deploy / deploy', jobConclusion: 'failure', steps: [{name:'Switch backend',conclusion:'success'}, {name:'Health check',conclusion:'success'}],
    extra: undefined as ((url: URL, init?: RequestInit) => Response | undefined) | undefined };
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)); state.calls.push(url.href);
    expect(url.origin).toBe('https://api.github.com');
    const special = state.extra?.(url, init); if (special) return special;
    const p = url.pathname.replace(`/repos/${repo}`, '');
    if (p === '/deployments/2') return Response.json(current);
    if (p === '/deployments/1') return Response.json(previous);
    if (p.endsWith('/statuses')) return Response.json([{state:'success'}]);
    if (p === '/deployments') return Response.json(state.history);
    if (p.startsWith('/actions/workflows/')) return Response.json({id: p.endsWith('rollback.yml') ? 2 : 1});
    const run = /^\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?$/.exec(p);
    if (run) { const id = Number(run[1]), currentRun = id === 20;
      return Response.json({id,run_attempt:currentRun ? state.attempt : 1, workflow_id:currentRun && state.workflow==='rollback'?2:1,
        path:`.github/workflows/${currentRun?state.workflow:'ci'}.yml`,event:currentRun?state.event:'push',head_branch:'main',
        head_sha:currentRun?state.head:A,repository:{full_name:repo},head_repository:{full_name:repo},actor:{login:'GrayMouse9'}}); }
    if (p.endsWith('/jobs')) return Response.json({jobs:[{id:200,name:state.jobName,steps:state.steps}]});
    if (p === '/actions/jobs/200') return Response.json({id:200,name:state.jobName,run_id:20,run_attempt:state.attempt,head_sha:state.head,status:'completed',conclusion:state.jobConclusion});
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  }) as typeof fetch;
  const api = createReleaseApi({repository:repo, token:'test',fetch:fetcher});
  return {...state, state, api, fetcher};
}
