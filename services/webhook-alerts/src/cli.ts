import { openStore } from './store';

export function retry(databasePath: string, id: number, now = Date.now()): boolean {
  const store = openStore(databasePath);
  try { return store.retryFailed(id, now); }
  finally { store.close(); }
}

if (import.meta.main) {
  const [command, idText, ...extra] = Bun.argv.slice(2);
  if (command !== 'retry' || !idText || !/^[1-9]\d*$/.test(idText) || !Number.isSafeInteger(Number(idText)) || extra.length > 0) {
    console.error('Usage: bun run src/cli.ts retry <failed-outbox-id>');
    process.exitCode = 1;
  } else {
    try {
      if (!retry(Bun.env.DATABASE_PATH ?? '/data/queue.sqlite', Number(idText))) {
        console.error('No failed outbox row with this ID');
        process.exitCode = 1;
      }
    } catch {
      console.error('Retry failed: database unavailable');
      process.exitCode = 1;
    }
  }
}
