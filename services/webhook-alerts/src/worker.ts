import { setTimeout } from 'node:timers/promises';
import type { Store, Delivery, OutgoingMessage } from './store';
import type { SendResult } from './telegram';

interface WorkerDeps {
  store: Store;
  project: (delivery: Delivery) => Promise<OutgoingMessage[]>;
  send: (message: OutgoingMessage) => Promise<SendResult>;
}

// One worker, at most ten claimed messages; even two 5s requests per row fit this lease.
const LEASE_MS = 120000;
function backoff(attempts: number): number {
  const ceiling = Math.min(60000, 1000 * 2 ** Math.min(attempts, 6));
  return Math.floor(ceiling / 2 + Math.random() * ceiling / 2);
}
async function sendSafely(send: WorkerDeps['send'], message: OutgoingMessage): Promise<SendResult> {
  try { return await send(message); }
  catch { return { kind: 'retry', errorCode: 'network' }; }
}

export async function runOnce({ store, project, send, now }: WorkerDeps & { now: number }): Promise<number> {
  const startedAt = performance.now();
  for (const delivery of store.claimUnprepared(now, LEASE_MS)) {
    try { store.prepare(delivery.id, await project(delivery)); }
    catch {
      console.error(JSON.stringify({ deliveryId: delivery.id, errorCode: 'preparation_failed' }));
      // The preparation lease expires; raw delivery remains durable and unprepared.
    }
  }
  const messages = store.claimDue(now, LEASE_MS);
  for (const message of messages) {
    let result = await sendSafely(send, message);
    if (result.kind === 'entities' && message.fallbackHtml !== undefined) {
      // Persist the reduced card before retrying, so later retries never restore the quote.
      store.useFallback(message.id);
      const { fallbackHtml, ...card } = message;
      result = await sendSafely(send, { ...card, html: fallbackHtml });
    }
    if (result.kind === 'sent') store.markSent(message.id, result.telegramMessageId);
    else if (result.kind === 'retry') {
      // Rate-limit windows start at the response, even for slow requests or earlier rows.
      const completedAt = now + Math.ceil(performance.now() - startedAt);
      const delay = result.retryAfterMs !== undefined && Number.isSafeInteger(completedAt + result.retryAfterMs)
        ? result.retryAfterMs : backoff(message.attempts);
      store.markRetry(message.id, completedAt + delay, result.errorCode);
    } else store.markFailed(message.id, result.errorCode);
    console.info(JSON.stringify({ outboxId: message.id, originType: message.originType, originId: message.originId,
      attempt: message.attempts, result: result.kind,
      ...(result.kind === 'sent' ? { httpStatus: 200 } : { errorCode: result.errorCode, httpStatus: result.httpStatus }) }));
    // At least once: a crash after Telegram accepts but before markSent may send a duplicate.
  }
  return messages.length;
}

export async function startWorker(deps: WorkerDeps & { signal: AbortSignal }): Promise<void> {
  while (!deps.signal.aborted) {
    try { await runOnce({ ...deps, now: Date.now() }); }
    catch { console.error(JSON.stringify({ errorCode: 'worker_iteration_failed' })); }
    if (deps.signal.aborted) break;
    try { await setTimeout(1000, undefined, { signal: deps.signal }); }
    catch { if (deps.signal.aborted) break; }
  }
}
