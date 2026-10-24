import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config';
import { createApp, MAX_BODY_BYTES } from './http';

if (import.meta.main) {
  const config = loadConfig(Bun.env);
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath, { create: true });
  const app = createApp({
    config,
    checkDb: () => { db.query('SELECT 1').get(); },
    // Task 2 replaces this with transactional durable intake. Never acknowledge a lost delivery.
    accept: () => { throw new Error('durable intake is not configured'); },
  });
  Bun.serve({ port: config.port, hostname: '0.0.0.0', fetch: app.fetch, maxRequestBodySize: MAX_BODY_BYTES });
  // No worker starts until durable intake and delivery are implemented and explicitly enabled.
}
