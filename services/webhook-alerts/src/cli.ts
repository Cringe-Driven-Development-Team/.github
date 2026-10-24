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
  if (command === 'snapshot' && first === '--output' && second && extra.length === 0) {
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
    console.error('Usage: bun run src/cli.ts retry <failed-outbox-id> | snapshot --output <snapshot-path>');
    process.exitCode = 1;
  }
}
