import { Hono } from 'hono';
import { verifyGithub } from './auth';
import type { Config } from './config';
import type { AcceptResult } from './store';
export type { AcceptResult } from './store';

export interface IncomingDelivery {
  source: 'github' | 'apidog';
  deliveryId: string;
  event: string;
  raw: Uint8Array;
}

export type AcceptDelivery = (delivery: IncomingDelivery) => AcceptResult | Promise<AcceptResult>;
export const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLarge extends Error {}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > MAX_BODY_BYTES) throw new BodyTooLarge();
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        // Do not wait for an untrusted stream's cancellation to finish.
        void reader.cancel().catch(() => {});
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }

  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

export function createApp(deps: {
  config: Config;
  accept: AcceptDelivery;
  checkDb: () => void | Promise<void>;
}): Hono {
  const app = new Hono();
  // Error messages can contain credentials or payload fragments; return fixed diagnostics only.
  app.onError(() => new Response('{"error":"internal_error"}', {
    status: 500, headers: { 'content-type': 'application/json' },
  }));

  app.get('/health', async c => {
    try { await deps.checkDb(); }
    catch { return c.json({ error: 'storage_unavailable' }, 503); }
    return c.json({ status: 'ok' });
  });

  app.post('/webhooks/github', async c => {
    let raw: Uint8Array;
    try { raw = await readBoundedBody(c.req.raw); }
    catch (error) {
      return error instanceof BodyTooLarge
        ? c.json({ error: 'body_too_large' }, 413)
        : c.json({ error: 'invalid_body' }, 400);
    }

    const signature = c.req.header('X-Hub-Signature-256') ?? '';
    if (!verifyGithub(raw, signature, deps.config.githubWebhookSecret)) {
      return c.json({ error: 'invalid_signature' }, 401);
    }

    const deliveryId = c.req.header('X-GitHub-Delivery')?.trim();
    const event = c.req.header('X-GitHub-Event')?.trim();
    if (!deliveryId || !event) return c.json({ error: 'missing_delivery_metadata' }, 400);
    if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return c.json({ error: 'json_required' }, 415);
    }

    try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { return c.json({ error: 'invalid_json' }, 400); }

    let result: AcceptResult;
    try { result = await deps.accept({ source: 'github', deliveryId, event, raw }); }
    catch { return c.json({ error: 'storage_unavailable' }, 503); }
    if (result === 'conflict') return c.json({ error: 'delivery_conflict' }, 409);
    return c.json({ status: result }, result === 'duplicate' ? 200 : 202);
  });

  return app;
}
