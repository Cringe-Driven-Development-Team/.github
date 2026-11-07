import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig, type Config } from './config';
import { CommandError, decodeUpdate, type Input } from './commands';
import { ApiError, ShutdownError, createGithub } from './github';
import { createProjects } from './projects';
import { createTelegram } from './telegram';
import { openStore } from './store';
import { handleJob } from './handler';

export function checkHealth(path: string, now: number): boolean {
  try {
    const { lastSuccess } = JSON.parse(readFileSync(path, 'utf8'));
    return typeof lastSuccess === 'number' && Number.isFinite(lastSuccess) && lastSuccess <= now && now - lastSuccess <= 120_000;
  } catch { return false; }
}

function pause(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function run(config: Config, fetcher: typeof fetch, signal: AbortSignal): Promise<void> {
  const heartbeat = join(dirname(config.databasePath), 'health.json');
  mkdirSync(dirname(config.databasePath), { recursive: true });
  rmSync(heartbeat, { force: true });
  if (signal.aborted) return;
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  signal.addEventListener('abort', shutdown, { once: true });
  let fatal: Error | undefined, started = false;
  const beat = () => { if (started && !stop.signal.aborted) writeFileSync(heartbeat, JSON.stringify({ lastSuccess: Date.now() })); };
  const guardedFetch = (async (url, init) => {
    if (stop.signal.aborted) throw new ShutdownError();
    const response = await fetcher(url, init);
    const github = new URL(String(url)).hostname === 'api.github.com';
    let denied = response.status === 401 || response.status === 403;
    if (denied && github && response.status === 403) {
      let message = '';
      try { message = String((await response.clone().json()).message); } catch { /* Status alone still identifies a permission denial. */ }
      if (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0' || /secondary rate limit|rate limit exceeded/i.test(message)) denied = false;
    }
    if (!github && response.ok) {
      try { const body = await response.clone().json(); denied = body.ok === false && [401, 403].includes(body.error_code); } catch { /* The adapter validates malformed JSON. */ }
    }
    if (denied) {
      fatal = new ApiError(github ? 'github' : 'telegram', 'rejected', `${github ? 'GitHub' : 'Telegram'} credentials or permissions rejected`);
      stop.abort();
    }
    if (response.ok) beat();
    return response;
  }) as typeof fetch;
  const telegram = createTelegram(config, guardedFetch);
  let store: ReturnType<typeof openStore> | undefined;
  try {
    const bot = await telegram.getMe();
    if (await telegram.getWebhookUrl()) throw new Error('Telegram webhook is configured; remove it explicitly before polling');
    const identity = await guardedFetch('https://api.github.com/user', {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${config.githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!identity.ok) throw new Error('GitHub startup probe failed');
    const user = await identity.json();
    if (!user || typeof user.login !== 'string' || !user.login) throw new Error('Invalid GitHub startup identity');
    if (stop.signal.aborted) { if (fatal) throw fatal; return; }
    store = openStore(config.databasePath); store.recover();
    const db = store;
    started = true;
    const deps = { config, store: db, github: createGithub(config, guardedFetch), projects: createProjects(config, guardedFetch),
      send: telegram.send, answerCallback: telegram.answerCallback, now: () => new Date() };
    async function poll() {
      while (!stop.signal.aborted) {
        try {
          const updates = await telegram.getUpdates(db.offset(), stop.signal);
          const inputs: Input[] = [];
          let offset = db.offset();
          for (const update of updates) {
            offset = Math.max(offset, (update as { update_id: number }).update_id + 1);
            try { const input = decodeUpdate(update, config, bot); if (input) inputs.push(input); }
            catch (error) {
              if (!(error instanceof CommandError)) throw error;
              inputs.push({ kind: 'error', updateId: error.updateId, context: error.context, actor: error.actor, message: error.message,
                ...(error.callbackId === undefined ? {} : { callbackId: error.callbackId }) });
            }
          }
          db.ingest(inputs, offset); beat();
          // Acknowledge receipt only; the durable worker validates the actual selection.
          for (const input of inputs) {
            if (input.kind === 'choice' || (input.kind === 'error' && input.callbackId)) {
              try { await telegram.answerCallback(input.callbackId!, 'Команда получена.'); }
              catch { if (!stop.signal.aborted) console.error('GitHubBot callback acknowledgement failed'); }
            }
          }
          if (!updates.length) await pause(stop.signal, 100);
        } catch (error) {
          if (stop.signal.aborted) return;
          if (!(error instanceof ApiError) || error.kind !== 'retryable') throw error;
          console.error('GitHubBot polling temporarily failed');
          await pause(stop.signal, error.retryAfterMs ?? 1000);
        }
      }
    }
    async function worker() {
      while (!stop.signal.aborted) {
        const job = db.nextJob(Date.now());
        if (job) { await handleJob(job, deps); beat(); }
        else await pause(stop.signal, 25);
      }
    }
    const supervise = async (operation: () => Promise<void>) => {
      try { await operation(); }
      catch (error) {
        if (!(error instanceof ShutdownError && stop.signal.aborted)) fatal ??= error instanceof Error ? error : new Error('GitHubBot runtime failed');
        stop.abort();
      }
    };
    await Promise.all([supervise(poll), supervise(worker)]);
    if (fatal) throw fatal;
  } catch (error) {
    if (fatal) throw fatal;
    if (!(error instanceof ShutdownError && signal.aborted)) throw error;
  } finally {
    stop.abort(); signal.removeEventListener('abort', shutdown);
    store?.close(); rmSync(heartbeat, { force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 1 && args[0] === '--health') {
      process.exitCode = checkHealth(join(dirname(process.env.DATABASE_PATH ?? '/data/githubbot.sqlite'), 'health.json'), Date.now()) ? 0 : 1;
    } else {
      if (args.length && !(args.length === 1 && args[0] === '--check-config')) throw new Error('Usage: main.ts [--check-config|--health]');
      const config = loadConfig(process.env);
      if (args[0] === '--check-config') console.log('GitHubBot configuration is valid');
      else {
        const abort = new AbortController();
        const terminate = () => abort.abort();
        process.on('SIGTERM', terminate); process.on('SIGINT', terminate);
        try { await run(config, fetch, abort.signal); }
        finally { process.off('SIGTERM', terminate); process.off('SIGINT', terminate); }
      }
    }
  } catch { console.error('GitHubBot stopped: configuration, startup or runtime failure'); process.exitCode = 1; }
}
