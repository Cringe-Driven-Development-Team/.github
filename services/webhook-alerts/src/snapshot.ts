import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function syncFile(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

export function createSnapshot(databasePath: string, outputPath: string): void {
  const source = resolve(databasePath);
  const output = resolve(outputPath);
  const live = statSync(source);
  const existing = existsSync(output) ? statSync(output) : undefined;
  if (source === output || (existing?.dev === live.dev && existing.ino === live.ino)) {
    throw new Error('Snapshot output must not be the live database');
  }
  const directory = dirname(output);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${output}.${randomUUID()}.tmp`;
  const previous = `${output}.${randomUUID()}.previous`;
  let savedPrevious = false;
  let published = false;
  try {
    // Reserve a private file; VACUUM INTO accepts an existing empty destination.
    closeSync(openSync(temporary, 'wx', 0o600));
    const db = new Database(source, { readonly: true, strict: true });
    try {
      db.exec('PRAGMA busy_timeout = 1000');
      db.query('VACUUM INTO ?').run(temporary);
    } finally { db.close(); }
    const snapshot = new Database(temporary, { readonly: true, strict: true });
    try {
      const checks = snapshot.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all();
      if (checks.length !== 1 || checks[0]!.integrity_check !== 'ok') throw new Error('Snapshot integrity check failed');
    } finally { snapshot.close(); }
    syncFile(temporary);
    if (existing) {
      linkSync(output, previous);
      savedPrevious = true;
    }
    // Persist the temporary file and rollback link before replacing the public path.
    syncFile(directory);
    renameSync(temporary, output);
    published = true;
    syncFile(directory);
  } catch (error) {
    if (published) {
      // Best effort on a filesystem error: an ordinary failure retains the old file.
      if (savedPrevious) { renameSync(previous, output); savedPrevious = false; }
      else unlinkSync(output);
      syncFile(directory);
    }
    throw error;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (savedPrevious) unlinkSync(previous);
  }
}
