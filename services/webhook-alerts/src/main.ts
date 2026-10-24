import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config';
import { createApp, MAX_BODY_BYTES } from './http';
import { openStore } from './store';

if (import.meta.main) {
  const config = loadConfig(Bun.env);
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const store = openStore(config.databasePath);
  const app = createApp({
    config,
    checkDb: () => store.checkHealth(),
    accept: delivery => store.accept(delivery),
  });
  Bun.serve({ port: config.port, hostname: '0.0.0.0', fetch: app.fetch, maxRequestBodySize: MAX_BODY_BYTES });
  // No worker starts until durable intake and delivery are implemented and explicitly enabled.
}
