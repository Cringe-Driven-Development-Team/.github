import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { githubReview } from './github';

export type AcceptResult = 'accepted' | 'duplicate' | 'conflict';

export interface DeliveryInput {
  source: 'github' | 'apidog';
  deliveryId?: string;
  event: string;
  raw: Uint8Array;
  receivedAt?: number;
}

export interface Delivery extends DeliveryInput {
  id: number;
  deliveryId: string;
  bodyHash: string;
  receivedAt: number;
  prepared: boolean;
  leaseUntil: number | null;
}

export interface OutgoingMessage {
  topic: number;
  html: string;
  button?: { text: string; url: string };
  fallbackHtml?: string;
}

export interface DueMessage extends OutgoingMessage {
  id: number;
  originType: 'delivery' | 'review_group';
  originId: number;
  ordinal: number;
  status: 'leased';
  attempts: number;
  dueAt: number;
  leaseUntil: number;
}

interface DeliveryRow {
  id: number;
  source: Delivery['source'];
  delivery_id: string;
  event: string;
  raw: Uint8Array;
  body_hash: string;
  received_at: number;
  prepared: number;
  lease_until: number | null;
}
interface ReviewGroupRow {
  id: number;
  revision: number;
  repository: string;
  pr_number: number;
  reviewer: string;
  due_at: number;
  sealed: number;
}
interface OutboxRow {
  id: number;
  origin_type: DueMessage['originType'];
  origin_id: number;
  ordinal: number;
  topic: number;
  html: string;
  button_json: string | null;
  fallback_html: string | null;
  attempts: number;
  due_at: number;
  lease_until: number;
}

function delivery(row: DeliveryRow): Delivery {
  return {
    id: row.id, source: row.source, deliveryId: row.delivery_id, event: row.event,
    raw: new Uint8Array(row.raw), bodyHash: row.body_hash, receivedAt: row.received_at,
    prepared: row.prepared === 1, leaseUntil: row.lease_until,
  };
}
function message(row: OutboxRow): DueMessage {
  return {
    id: row.id, originType: row.origin_type, originId: row.origin_id, ordinal: row.ordinal,
    topic: row.topic, html: row.html,
    ...(row.button_json === null ? {} : { button: JSON.parse(row.button_json) as OutgoingMessage['button'] }),
    ...(row.fallback_html === null ? {} : { fallbackHtml: row.fallback_html }),
    status: 'leased', attempts: row.attempts, dueAt: row.due_at, leaseUntil: row.lease_until,
  };
}

const HASH_WINDOW_MS = 5 * 60 * 1000;
const CLAIM_LIMIT = 10;
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const reviewSchema = readFileSync(new URL('./review-groups-schema.sql', import.meta.url), 'utf8');

export class Store {
  constructor(private readonly db: Database) {}

  accept(input: DeliveryInput): AcceptResult {
    if (!input.deliveryId?.trim() && input.source !== 'apidog') throw new Error('delivery ID required');
    const bodyHash = createHash('sha256').update(input.raw).digest('hex');
    const receivedAt = input.receivedAt ?? Date.now();
    const fallback = !input.deliveryId?.trim();
    const deliveryId = fallback ? `sha256:${bodyHash}:${receivedAt}` : input.deliveryId!;
    return this.db.transaction((): AcceptResult => {
      if (fallback) {
        // A rolling window also deduplicates notifications straddling fixed time buckets.
        const recent = this.db.query(`SELECT id FROM deliveries
          WHERE source = 'apidog' AND dedupe_kind = 'body_hash' AND body_hash = ?
          AND received_at > ? AND received_at <= ? LIMIT 1`).get(bodyHash, receivedAt - HASH_WINDOW_MS, receivedAt);
        if (recent) return 'duplicate';
      }
      const existing = this.db.query<{ body_hash: string }, [string, string]>(
        'SELECT body_hash FROM deliveries WHERE source = ? AND delivery_id = ?',
      ).get(input.source, deliveryId);
      if (existing) return existing.body_hash === bodyHash ? 'duplicate' : 'conflict';
      this.db.query(`INSERT INTO deliveries
        (source, delivery_id, dedupe_kind, event, raw, body_hash, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.source, deliveryId, fallback ? 'body_hash' : 'id', input.event, input.raw, bodyHash, receivedAt);
      return 'accepted';
    }).immediate();
  }

  claimUnprepared(now: number, leaseMs: number): Delivery[] {
    this.checkLease(now, leaseMs);
    return this.db.transaction(() => {
      const rows = this.db.query<DeliveryRow, [number, number]>(`SELECT * FROM deliveries
        WHERE prepared = 0 AND (lease_until IS NULL OR lease_until <= ?) ORDER BY id LIMIT ?`).all(now, CLAIM_LIMIT);
      const leaseUntil = now + leaseMs;
      for (const row of rows) {
        this.db.query('UPDATE deliveries SET lease_until = ? WHERE id = ?').run(leaseUntil, row.id);
        row.lease_until = leaseUntil;
      }
      return rows.map(delivery);
    }).immediate();
  }

  prepare(id: number, messages: OutgoingMessage[]): void {
    this.db.transaction(() => {
      const row = this.db.query<DeliveryRow, [number]>('SELECT * FROM deliveries WHERE id = ?').get(id);
      if (!row) throw new Error('unknown delivery');
      if (row.prepared) return;
      const insert = this.db.query(`INSERT INTO outbox
        (origin_type, origin_id, ordinal, topic, html, button_json, fallback_html, due_at)
        VALUES ('delivery', ?, ?, ?, ?, ?, ?, ?)`);
      messages.forEach((item, ordinal) => {
        insert.run(id, ordinal, item.topic, item.html, item.button ? JSON.stringify(item.button) : null,
          item.fallbackHtml ?? null, row.received_at);
      });
      this.db.query('UPDATE deliveries SET prepared = 1, lease_until = NULL WHERE id = ?').run(id);
    }).immediate();
  }

  recordReview(deliveryId: number, review: { repository: string; number: number; reviewer: string; id: number; state: string }, now: number): void {
    this.db.transaction(() => {
      if (this.db.query('SELECT delivery_id FROM review_group_deliveries WHERE delivery_id = ? OR (repository = ? AND review_id = ?)')
        .get(deliveryId, review.repository, review.id)) return;
      const sealed = review.state === 'commented' ? 0 : 1;
      const dueAt = now + (sealed ? 0 : 180000);
      const existing = this.db.query<{ id: number }, [string, number, string, number]>(`SELECT id FROM review_groups
        WHERE repository = ? AND pr_number = ? AND reviewer = ? AND released = 0 AND sealed = 0 AND due_at > ? ORDER BY id DESC LIMIT 1`)
        .get(review.repository, review.number, review.reviewer, now);
      const id = existing?.id ?? Number(this.db.query(`INSERT INTO review_groups (repository, pr_number, reviewer, due_at)
        VALUES (?, ?, ?, ?)`).run(review.repository, review.number, review.reviewer, dueAt).lastInsertRowid);
      this.db.query('INSERT INTO review_group_deliveries (delivery_id, group_id, review_id, repository) VALUES (?, ?, ?, ?)')
        .run(deliveryId, id, review.id, review.repository);
      this.db.query('UPDATE review_groups SET due_at = ?, sealed = ?, revision = revision + 1 WHERE id = ?').run(dueAt, sealed, id);
    }).immediate();
  }

  dueReviewGroups(now: number): { id: number; revision: number; deliveries: Delivery[] }[] {
    return this.db.transaction(() => this.db.query<ReviewGroupRow, [number]>(
      'SELECT * FROM review_groups WHERE released = 0 AND due_at <= ? ORDER BY id',
    ).all(now).filter(group => !this.hasUnrecordedReview(group)).slice(0, CLAIM_LIMIT).map(group => ({ ...group, deliveries: this.db.query<DeliveryRow, [number]>(`SELECT d.* FROM deliveries d
      JOIN review_group_deliveries r ON r.delivery_id = d.id WHERE r.group_id = ? ORDER BY d.received_at, d.id`).all(group.id).map(delivery) })))();
  }

  private hasUnrecordedReview(group: ReviewGroupRow): boolean {
    if (group.sealed) return false;
    // An accepted delivery can still be leased by a worker that crashed. Wait
    // for it to be recorded even though claimUnprepared cannot return it yet.
    const pending = this.db.query<DeliveryRow, [number]>(`SELECT d.* FROM deliveries d
      WHERE d.prepared = 0 AND d.source = 'github' AND d.event = 'pull_request_review' AND d.received_at < ?
      AND NOT EXISTS (SELECT 1 FROM review_group_deliveries r WHERE r.delivery_id = d.id)`).all(group.due_at);
    return pending.some(row => {
      try {
        const review = githubReview(delivery(row));
        return review?.repository === group.repository && review.number === group.pr_number && review.reviewer === group.reviewer;
      } catch {
        // Invalid input cannot join a group; it remains unprepared for diagnosis.
        return false;
      }
    });
  }

  releaseReviewGroup(id: number, revision: number, messages: OutgoingMessage[], now: number): boolean {
    return this.db.transaction(() => {
      const group = this.db.query<ReviewGroupRow, [number]>('SELECT * FROM review_groups WHERE id = ?').get(id);
      // Recheck accepted deliveries under the write lock: one may have arrived
      // while the asynchronous projection was waiting for GitHub.
      if (!group || this.hasUnrecordedReview(group)) return false;
      const updated = this.db.query('UPDATE review_groups SET released = 1 WHERE id = ? AND revision = ? AND released = 0 AND due_at <= ?')
        .run(id, revision, now);
      if (!updated.changes) return false;
      const insert = this.db.query(`INSERT INTO outbox
        (origin_type, origin_id, ordinal, topic, html, button_json, fallback_html, due_at)
        VALUES ('review_group', ?, ?, ?, ?, ?, ?, ?)`);
      messages.forEach((item, ordinal) => insert.run(id, ordinal, item.topic, item.html,
        item.button ? JSON.stringify(item.button) : null, item.fallbackHtml ?? null, now));
      return true;
    }).immediate();
  }

  claimDue(now: number, leaseMs: number): DueMessage[] {
    this.checkLease(now, leaseMs);
    return this.db.transaction(() => {
      const rows = this.db.query<OutboxRow, [number, number, number]>(`SELECT * FROM outbox
        WHERE (status = 'pending' AND due_at <= ?) OR (status = 'leased' AND lease_until <= ?)
        ORDER BY id LIMIT ?`).all(now, now, CLAIM_LIMIT);
      const leaseUntil = now + leaseMs;
      for (const row of rows) {
        this.db.query("UPDATE outbox SET status = 'leased', attempts = attempts + 1, lease_until = ? WHERE id = ?").run(leaseUntil, row.id);
        row.attempts++;
        row.lease_until = leaseUntil;
      }
      return rows.map(message);
    }).immediate();
  }

  markSent(id: number, telegramMessageId: number): void {
    this.db.query("UPDATE outbox SET status = 'sent', telegram_message_id = ?, lease_until = NULL, error_code = NULL WHERE id = ? AND status = 'leased'").run(telegramMessageId, id);
  }

  markRetry(id: number, dueAt: number, errorCode: string): void {
    this.db.query("UPDATE outbox SET status = 'pending', due_at = ?, lease_until = NULL, error_code = ? WHERE id = ? AND status = 'leased'").run(dueAt, errorCode, id);
  }

  markFailed(id: number, errorCode: string): void {
    this.db.query("UPDATE outbox SET status = 'failed', lease_until = NULL, error_code = ? WHERE id = ? AND status = 'leased'").run(errorCode, id);
  }

  useFallback(id: number): void {
    this.db.query("UPDATE outbox SET html = fallback_html, fallback_html = NULL WHERE id = ? AND status = 'leased' AND fallback_html IS NOT NULL").run(id);
  }

  retryFailed(id: number, now: number): boolean {
    return this.db.query("UPDATE outbox SET status = 'pending', due_at = ?, lease_until = NULL, error_code = NULL WHERE id = ? AND status = 'failed'").run(now, id).changes === 1;
  }

  checkHealth(): void { this.db.query('SELECT 1 FROM deliveries LIMIT 1').get(); }
  close(): void { this.db.close(); }

  private checkLease(now: number, leaseMs: number): void {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(now + leaseMs)) {
      throw new Error('invalid lease time');
    }
  }
}

export function openStore(path: string): Store {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec('PRAGMA busy_timeout = 1000');
    db.exec('PRAGMA journal_mode = WAL');
    // WAL + FULL syncs every acknowledged commit, including across a power failure.
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
      if (version > 2) throw new Error('unsupported database schema');
      if (version === 0) {
        db.exec(schema);
      }
      if (version < 2) {
        db.exec(reviewSchema);
        db.exec('PRAGMA user_version = 2');
      }
    }).immediate();
    return new Store(db);
  } catch (error) {
    db.close();
    throw error;
  }
}
