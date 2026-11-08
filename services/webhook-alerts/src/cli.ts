import { checkBackendReleaseAccess } from './release-preflight';
import { openStore } from './store';
import { createSnapshot } from './snapshot';

export function retry(databasePath: string, id: number, now = Date.now()): boolean {
  const store = openStore(databasePath);
  try { return store.retryFailed(id, now); }
  finally { store.close(); }
}

if (import.meta.main) {
  const [command, first, second, ...extra] = Bun.argv.slice(2);
  const databasePath = Bun.env.DATABASE_PATH ?? '/data/queue.sqlite';
  if (command === 'backend-release-check' && first === undefined) {
    try {
      const topic = Number(Bun.env.TELEGRAM_BACKEND_RELEASES_TOPIC_ID);
      if (!Number.isSafeInteger(topic) || topic <= 0) throw new Error();
      await checkBackendReleaseAccess(Bun.env.GITHUB_API_TOKEN ?? '');
      console.info('Backend release read access and topic configuration checked; verify subscriptions and topic identity separately');
    } catch { console.error('Backend release preflight failed: check topic, API permissions and producer workflows'); process.exitCode = 1; }
  } else if (['release-activate','backend-release-activate'].includes(command ?? '') && first && second === undefined) {
    try {
      const backend=command === 'backend-release-activate';
      const cutoff=Date.parse(first), topic=Number(Bun.env[backend ? 'TELEGRAM_BACKEND_RELEASES_TOPIC_ID' : 'TELEGRAM_RELEASES_TOPIC_ID']);
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(first) || !Number.isSafeInteger(cutoff)
        || cutoff > Date.now() || (new Date(cutoff).toISOString() !== first && new Date(cutoff).toISOString().replace('.000Z','Z') !== first)
        || !Number.isSafeInteger(topic) || topic <= 0 || !Bun.env.GITHUB_API_TOKEN?.trim()) throw new Error();
      const store=openStore(databasePath);
      try { store.activateReleases(cutoff,backend ? 'Cringe-Driven-Development-Team/backend' : 'Cringe-Driven-Development-Team/frontend'); } finally { store.close(); }
    } catch { console.error('Release activation failed: check UTC cutoff, topic, API token and database'); process.exitCode=1; }
  } else if (command === 'release-recover' && first && /^[1-9]\d*$/.test(first) && Number.isSafeInteger(Number(first)) && second === undefined) {
    try {
      const store=openStore(databasePath);
      try { if (!store.recoverReleaseDelivery(Number(first))) throw new Error(); } finally { store.close(); }
    } catch { console.error('Release recovery failed: no matching raw release delivery'); process.exitCode=1; }
  } else if (command === 'snapshot' && first === '--output' && second && extra.length === 0) {
    try { createSnapshot(databasePath, second); }
    catch {
      console.error('Snapshot failed: unable to create a verified database snapshot');
      process.exitCode = 1;
    }
  } else if (command === 'retry' && first && /^[1-9]\d*$/.test(first) && Number.isSafeInteger(Number(first)) && second === undefined) {
    try {
      if (!retry(databasePath, Number(first))) {
        console.error('No failed outbox row with this ID');
        process.exitCode = 1;
      }
    } catch {
      console.error('Retry failed: database unavailable');
      process.exitCode = 1;
    }
  } else {
    console.error('Usage: bun run src/cli.ts retry <failed-outbox-id> | snapshot --output <snapshot-path> | release-activate <UTC-ISO> | backend-release-activate <UTC-ISO> | backend-release-check | release-recover <delivery-id>');
    process.exitCode = 1;
  }
}
