import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config';
import { startService } from '../src/main';
import { createSnapshot } from '../src/snapshot';
import { openStore } from '../src/store';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'hooks-snapshot-'));
  directories.push(path);
  return path;
}
const raw = new TextEncoder().encode('{"event":"endpoint.updated"}');

test('snapshots committed WAL rows and restores pending/sent deliveries and dedupe without sending', async () => {
  const root = directory();
  const path = join(root, 'queue.sqlite');
  const output = join(root, 'snapshots', 'queue.sqlite');
  const store = openStore(path);
  try {
    store.accept({ source: 'github', deliveryId: 'sent-delivery', event: 'push', raw, receivedAt: 100 });
    store.accept({ source: 'github', deliveryId: 'pending-delivery', event: 'push', raw, receivedAt: 200 });
    store.accept({ source: 'apidog', event: 'endpoint.updated', raw, receivedAt: 300 });
    store.prepare(1, [{ topic: 26, html: 'sent' }]);
    store.prepare(2, [{ topic: 26, html: 'pending' }]);
    store.markSent(store.claimDue(100, 1000)[0]!.id, 42);
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    createSnapshot(path, output);
    expect(readdirSync(join(root, 'snapshots'))).toEqual(['queue.sqlite']);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    // Copy only the completed file while the original WAL connection stays open.
    const restoredPath = join(directory(), 'queue.sqlite');
    copyFileSync(output, restoredPath);
    const restored = new Database(restoredPath, { readonly: true });
    try {
      expect(restored.query('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
      expect(restored.query('SELECT id, delivery_id, dedupe_kind FROM deliveries ORDER BY id').all()).toEqual([
        { id: 1, delivery_id: 'sent-delivery', dedupe_kind: 'id' },
        { id: 2, delivery_id: 'pending-delivery', dedupe_kind: 'id' },
        { id: 3, delivery_id: expect.stringMatching(/^sha256:/), dedupe_kind: 'body_hash' },
      ]);
      expect(restored.query('SELECT id, origin_id, status, telegram_message_id FROM outbox ORDER BY id').all()).toEqual([
        { id: 1, origin_id: 1, status: 'sent', telegram_message_id: 42 },
        { id: 2, origin_id: 2, status: 'pending', telegram_message_id: null },
      ]);
    } finally { restored.close(); }
    expect(existsSync(`${restoredPath}-wal`)).toBe(false);
    const reopened = openStore(restoredPath);
    try {
      expect(reopened.accept({ source: 'github', deliveryId: 'sent-delivery', event: 'push', raw })).toBe('duplicate');
      expect(reopened.accept({ source: 'github', deliveryId: 'pending-delivery', event: 'push', raw })).toBe('duplicate');
      expect(reopened.accept({ source: 'apidog', event: 'endpoint.updated', raw, receivedAt: 301 })).toBe('duplicate');
    } finally { reopened.close(); }
    let calls = 0;
    const service = startService(loadConfig({
      DATABASE_PATH: restoredPath, WEBHOOK_ALERTS_SEND_ENABLED: 'false',
      GITHUB_WEBHOOK_SECRET: 'test', APIDOG_SIGNATURE_KEY: 'test', APIDOG_SIGNATURE_HEADER: 'x-test-signature',
    }), { fetch: (async () => { calls++; throw new Error('network forbidden during restore'); }) as unknown as typeof fetch });
    try {
      expect((await service.app.request('/health')).status).toBe(200);
      await Bun.sleep(20);
      expect(calls).toBe(0);
    } finally { await service.stop(); }
    const final = new Database(restoredPath, { readonly: true });
    try {
      expect(final.query('SELECT status FROM outbox ORDER BY id').all()).toEqual([{ status: 'sent' }, { status: 'pending' }]);
      expect(final.query('SELECT count(*) AS count FROM deliveries').get()).toEqual({ count: 3 });
    } finally { final.close(); }
  } finally { store.close(); }
});

test('replaces an existing snapshot and preserves it if a later snapshot fails', () => {
  const root = directory();
  const path = join(root, 'queue.sqlite');
  const output = join(root, 'snapshots', 'queue.sqlite');
  const store = openStore(path);
  try {
    createSnapshot(path, output);
    store.accept({ source: 'github', deliveryId: 'new-delivery', event: 'push', raw });
    createSnapshot(path, output);
    const db = new Database(output, { readonly: true });
    try { expect(db.query('SELECT delivery_id FROM deliveries').all()).toEqual([{ delivery_id: 'new-delivery' }]); }
    finally { db.close(); }
    const previous = readFileSync(output);
    const invalid = join(root, 'invalid.sqlite');
    writeFileSync(invalid, 'not a SQLite database');
    expect(() => createSnapshot(invalid, output)).toThrow();
    expect(readFileSync(output)).toEqual(previous);
    expect(readdirSync(join(root, 'snapshots'))).toEqual(['queue.sqlite']);
  } finally { store.close(); }
});

test('refuses the live database including normalized paths, symbolic links and hard links', () => {
  const root = directory();
  const path = join(root, 'queue.sqlite');
  const store = openStore(path);
  try {
    store.accept({ source: 'github', deliveryId: 'untouched', event: 'push', raw });
    const symbolic = join(root, 'symbolic.sqlite');
    const hard = join(root, 'hard.sqlite');
    symlinkSync(path, symbolic);
    linkSync(path, hard);
    for (const output of [path, join(root, 'snapshots', '..', 'queue.sqlite'), symbolic, hard]) {
      expect(() => createSnapshot(path, output)).toThrow('live database');
    }
    expect(store.accept({ source: 'github', deliveryId: 'untouched', event: 'push', raw })).toBe('duplicate');
  } finally { store.close(); }
});

test('CLI snapshots without sender credentials and exits nonzero on invalid output or arguments', () => {
  const root = directory();
  const path = join(root, 'queue.sqlite');
  const output = join(root, 'snapshots', 'queue.sqlite');
  const store = openStore(path);
  try {
    store.accept({ source: 'github', deliveryId: 'cli-delivery', event: 'push', raw });
    const cli = resolve(import.meta.dir, '../src/cli.ts');
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, cli, ...args], { env: { DATABASE_PATH: path } });
    expect(run('snapshot', '--output', output).exitCode).toBe(0);
    const db = new Database(output, { readonly: true });
    try { expect(db.query('SELECT delivery_id FROM deliveries').all()).toEqual([{ delivery_id: 'cli-delivery' }]); }
    finally { db.close(); }
    expect(run('snapshot', '--output', path).exitCode).not.toBe(0);
    expect(run('snapshot').exitCode).not.toBe(0);
    expect(run('snapshot', '--output', output, 'extra').exitCode).not.toBe(0);
  } finally { store.close(); }
});
