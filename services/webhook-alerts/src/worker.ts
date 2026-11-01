import type { ApidogApi } from './apidog-api';
import type { ApidogMergeConfig } from './apidog-merge';
import { setTimeout } from 'node:timers/promises';
import type { Store, Delivery, DueMessage, OutgoingMessage, DeliveryLane, ReleaseNotice } from './store';
import type { SendResult } from './telegram';
import { formatGithub, formatGithubReviewGroup, githubReview, type FormatConfig } from './github';
import type { GithubApi } from './github-api';
import { ReviewGroups } from './review-groups';
import { formatApidogMr, type FormatConfig as ApidogFormatConfig } from './apidog';

interface Projector {
  (delivery: Delivery): Promise<OutgoingMessage[]>;
  reviewGroup?: (deliveries: Delivery[]) => Promise<OutgoingMessage[]>;
}

interface WorkerDeps {
  store: Store;
  project: Projector;
  send: (message: DueMessage) => Promise<SendResult>;
  releaseProject?: Projector;
  beforeReleaseSend?: (notice:ReleaseNotice)=>Promise<'send'|'skip'|'retry'>;
}

// One worker, at most ten claimed messages; even two 5s requests per row fit this lease.
const LEASE_MS = 120000;
function backoff(attempts: number): number {
  const ceiling = Math.min(60000, 1000 * 2 ** Math.min(attempts, 6));
  return Math.floor(ceiling / 2 + Math.random() * ceiling / 2);
}
async function sendSafely(send: WorkerDeps['send'], message: DueMessage): Promise<SendResult> {
  try { return await send(message); }
  catch { return { kind: 'retry', errorCode: 'network', ambiguous:true }; }
}

export async function prepareOnce({store,project,now,lane='ordinary'}: Pick<WorkerDeps,'store'|'project'> & {now:number;lane?:DeliveryLane}): Promise<void> {
  const groups = new ReviewGroups(store);
  // Drain accepted deliveries before releasing timers: a queued verdict may be
  // beyond the first claim batch and must supersede its comments first.
  for (;;) {
    const batch = store.claimUnprepared(now, LEASE_MS,lane);
    if (!batch.length) break;
    for (const delivery of batch) {
      try {
        if (lane === 'ordinary' && githubReview(delivery)) {
          if (!project.reviewGroup) throw new Error('review group projector required');
          groups.record(delivery, delivery.receivedAt);
          store.prepare(delivery.id, []);
        } else store.prepare(delivery.id, await project(delivery));
      }
      catch {
        console.error(JSON.stringify({ deliveryId: delivery.id, errorCode: 'preparation_failed' }));
        // The preparation lease expires; raw delivery remains durable and unprepared.
      }
    }
  }
  if (lane === 'ordinary' && project.reviewGroup) {
    try { await groups.releaseDue(now, project.reviewGroup); }
    catch { console.error(JSON.stringify({ errorCode: 'review_group_preparation_failed' })); }
  }
}

export async function runOnce(deps:WorkerDeps & {now:number}):Promise<number> {
  const startedAt=performance.now();
  await prepareOnce({...deps,lane:'ordinary'});
  return deliverOnce({...deps,startedAt});
}

export async function deliverOnce({store,send,beforeReleaseSend,now,startedAt=performance.now()}: Pick<WorkerDeps,'store'|'send'|'beforeReleaseSend'> & {now:number;startedAt?:number}): Promise<number> {
  let count=0;
  for (let i=0;i<10;i++) {
    const message=store.claimDue(now, LEASE_MS, 1)[0];
    if (!message) break;
    count++;
    if (message.release && beforeReleaseSend) {
      let guard:'send'|'skip'|'retry';
      try {guard=await beforeReleaseSend(message.release);} catch {guard='retry';}
      if (guard === 'skip') {store.skipRelease(message.id,'stale');continue;}
      if (guard === 'retry') {store.markRetry(message.id,now+Math.ceil(performance.now()-startedAt)+backoff(message.attempts),'release_guard_unavailable');continue;}
    }
    if (message.release && !store.beginReleaseSend(message.id, now + Math.floor(performance.now()-startedAt))) continue;
    let result = await sendSafely(send, message);
    if (result.kind === 'entities' && message.fallbackHtml !== undefined) {
      // Persist the reduced card before retrying, so later retries never restore the quote.
      store.useFallback(message.id);
      const { fallbackHtml, ...card } = message;
      result = await sendSafely(send, { ...card, html: fallbackHtml });
    }
    if (result.kind === 'sent') store.markSent(message.id, result.telegramMessageId);
    else if (result.kind === 'retry' && result.ambiguous && message.release) store.markFailed(message.id,'release_uncertain');
    else if (result.kind === 'retry') {
      // Rate-limit windows start at the response, even for slow requests or earlier rows.
      const completedAt = now + Math.ceil(performance.now() - startedAt);
      const delay = result.retryAfterMs !== undefined && Number.isSafeInteger(completedAt + result.retryAfterMs)
        ? result.retryAfterMs : backoff(message.attempts);
      store.markRetry(message.id, completedAt + delay, result.errorCode);
    } else store.markFailed(message.id, result.errorCode);
    console.info(JSON.stringify({ outboxId: message.id, originType: message.originType, originId: message.originId,
      attempt: message.attempts, result: result.kind === 'retry' && result.ambiguous && message.release ? 'uncertain' : result.kind,
      ...(result.kind === 'sent' ? { httpStatus: 200 } : { errorCode: result.errorCode, httpStatus: result.httpStatus }) }));
    // At least once: a crash after Telegram accepts but before markSent may send a duplicate.
  }
  return count;
}

export async function startWorker(deps: WorkerDeps & { signal: AbortSignal; pollApidog?: () => Promise<void> }): Promise<void> {
  let nextApidogPoll=0,wake=new AbortController();
  async function loop(task:()=>Promise<void>,sender=false):Promise<void> {
    while(!deps.signal.aborted){
      try {await task();} catch {console.error(JSON.stringify({errorCode:'worker_iteration_failed'}));}
      if(deps.signal.aborted)break;
      if(sender){
        const current=wake;
        if(!current.signal.aborted)try {await setTimeout(1000,undefined,{signal:AbortSignal.any([deps.signal,current.signal])});}catch{}
        if(wake===current)wake=new AbortController();
      }else try {await setTimeout(1000,undefined,{signal:deps.signal});}catch{}
    }
  }
  const preparations=[loop(async()=>{
    if(deps.pollApidog&&Date.now()>=nextApidogPoll){try{await deps.pollApidog();}catch{console.error(JSON.stringify({errorCode:'apidog_mr_poll_failed'}));}nextApidogPoll=Date.now()+30000;}
    if(deps.signal.aborted)return;
    await prepareOnce({...deps,now:Date.now(),lane:'ordinary'});wake.abort();
  })];
  if(deps.releaseProject)for(const lane of ['release-queue','release-operation'] as const)preparations.push(loop(async()=>{
    await prepareOnce({store:deps.store,project:deps.releaseProject!,now:Date.now(),lane});wake.abort();
  }));
  await Promise.all([...preparations,loop(async()=>{await deliverOnce({...deps,now:Date.now()});},true)]);
}

export function createGithubProjector(api: GithubApi, config: FormatConfig = {}): WorkerDeps['project'] {
  return Object.assign((delivery: Delivery) => formatGithub(delivery, api, config), {
    reviewGroup: (deliveries: Delivery[]) => formatGithubReviewGroup(deliveries, api, config),
  });
}

export function createProjector(api: GithubApi, config: FormatConfig & ApidogFormatConfig, merge?: { api: ApidogApi; config: ApidogMergeConfig }): WorkerDeps['project'] {
  const github = createGithubProjector(api, config);
  return Object.assign(async (delivery: Delivery) => delivery.source === 'apidog'
    ? merge ? formatApidogMr(delivery, { ...config, ...merge.config }) : [] : github(delivery), { reviewGroup: github.reviewGroup });
}
