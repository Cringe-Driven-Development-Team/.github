import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ApidogMr } from './apidog-api';
import { githubReview } from './github';

export type DeliveryLane = 'ordinary' | 'release-queue' | 'release-operation';
export type ReleaseNotice = { key: string } & (
  {kind:'queue';prNumber:number;queueEntryId:string} | {kind:'dequeue';prNumber:number} |
  {kind:'ready';sha:string;operationKey:string} | {kind:'start'|'result';deploymentId:number;runId:number} |
  {kind:'job-error'|'retention';runId:number;attempt:number;jobId:number}
);

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
  releaseRecovery?: boolean;
}

export interface OutgoingMessage {
  topic: number;
  html: string;
  button?: { text: string; url: string };
  secondaryButton?: { text: string; url: string };
  fallbackHtml?: string;
  keyboard?: {text:string;url:string}[][];
  release?: ReleaseNotice;
}

export interface DueMessage extends OutgoingMessage {
  id: number;
  source: Delivery['source'];
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
  lane: DeliveryLane;
  recovery_allowed?: number;
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
  source: Delivery['source'] | null;
  origin_type: DueMessage['originType'];
  origin_id: number;
  ordinal: number;
  topic: number;
  html: string;
  button_json: string | null;
  fallback_html: string | null;
  keyboard_json: string | null;
  metadata_json: string | null;
  attempts: number;
  due_at: number;
  lease_until: number;
}

function delivery(row: DeliveryRow): Delivery {
  return {
    id: row.id, source: row.source, deliveryId: row.delivery_id, event: row.event,
    raw: new Uint8Array(row.raw), bodyHash: row.body_hash, receivedAt: row.received_at,
    prepared: row.prepared === 1, leaseUntil: row.lease_until,
    ...(row.recovery_allowed === 1 ? {releaseRecovery:true} : {}),
  };
}
function buttonJson(item: OutgoingMessage): string | null {
  return item.button ? JSON.stringify({
    ...item.button,
    ...(item.secondaryButton ? { secondaryButton: item.secondaryButton } : {}),
  }) : null;
}

function message(row: OutboxRow): DueMessage {
  if (row.source !== 'github' && row.source !== 'apidog') throw new Error('outbox origin has no source');
  const buttons = row.button_json === null ? undefined : JSON.parse(row.button_json) as NonNullable<OutgoingMessage['button']> & Pick<OutgoingMessage, 'secondaryButton'>;
  return {
    id: row.id, source: row.source, originType: row.origin_type, originId: row.origin_id, ordinal: row.ordinal,
    topic: row.topic, html: row.html,
    ...(buttons ? { button: { text: buttons.text, url: buttons.url } } : {}),
    ...(buttons?.secondaryButton ? { secondaryButton: buttons.secondaryButton } : {}),
    ...(row.fallback_html === null ? {} : { fallbackHtml: row.fallback_html }),
    ...(row.keyboard_json ? {keyboard:JSON.parse(row.keyboard_json)} : {}),
    ...(row.metadata_json ? {release:JSON.parse(row.metadata_json)} : {}),
    status: 'leased', attempts: row.attempts, dueAt: row.due_at, leaseUntil: row.lease_until,
  };
}

function hash(raw: Uint8Array): string {
  return createHash('sha256').update(raw).digest('hex');
}

const HASH_WINDOW_MS = 5 * 60 * 1000;
const CLAIM_LIMIT = 10;
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const releaseSchema = readFileSync(new URL('./release-schema.sql', import.meta.url), 'utf8');

function lane(input: DeliveryInput): DeliveryLane {
  if (input.source !== 'github') return 'ordinary';
  try {
    const payload=JSON.parse(new TextDecoder().decode(input.raw));
    if (payload?.repository?.full_name !== 'Cringe-Driven-Development-Team/frontend') return 'ordinary';
    if (input.event === 'pull_request' && ['enqueued','dequeued'].includes(payload.action)) return 'release-queue';
    if (['deployment_status','workflow_job'].includes(input.event)) return 'release-operation';
  } catch { /* Other accepted events retain their original preparation path. */ }
  return 'ordinary';
}

const reviewSchema = readFileSync(new URL('./review-groups-schema.sql', import.meta.url), 'utf8');

export class Store {
  constructor(private readonly db: Database) {}

  accept(input: DeliveryInput): AcceptResult {
    if (!input.deliveryId?.trim() && input.source !== 'apidog') throw new Error('delivery ID required');
    const bodyHash = hash(input.raw);
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
        (source, delivery_id, dedupe_kind, event, raw, body_hash, received_at, lane)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.source, deliveryId, fallback ? 'body_hash' : 'id', input.event, input.raw, bodyHash, receivedAt, lane(input));
      return 'accepted';
    }).immediate();
  }

  startApidogMrMonitoring(now: number): void {
    if (!Number.isSafeInteger(now)) throw new Error('invalid monitoring cutoff');
    this.db.query(`UPDATE outbox SET status = 'failed', lease_until = NULL, error_code = 'APIDOG_RAW_SUPPRESSED'
      WHERE status IN ('pending', 'leased', 'failed') AND origin_type = 'delivery'
      AND origin_id IN (SELECT id FROM deliveries WHERE source = 'apidog' AND delivery_id NOT GLOB 'mr-poll:*')`).run();
    const raw = new TextEncoder().encode('{}');
    this.db.query(`INSERT INTO deliveries
      (source, delivery_id, dedupe_kind, event, raw, body_hash, received_at, prepared)
      VALUES ('apidog', 'mr-poll:cutoff', 'id', 'MR_MONITORING_STARTED', ?, ?, ?, 1)
      ON CONFLICT (source, delivery_id) DO NOTHING`).run(raw, hash(raw), now);
  }

  recordApidogMergeRequests(rows: ApidogMr[]): number {
    return this.db.transaction(() => {
      const cutoff = this.db.query<{ received_at: number }, []>(
        "SELECT received_at FROM deliveries WHERE source = 'apidog' AND delivery_id = 'mr-poll:cutoff'",
      ).get();
      if (!cutoff) throw new Error('Apidog MR monitoring not started');
      const insert = this.db.query(`INSERT INTO deliveries
        (source, delivery_id, dedupe_kind, event, raw, body_hash, received_at, prepared)
        VALUES ('apidog', ?, 'id', ?, ?, ?, ?, ?)
        ON CONFLICT (source, delivery_id) DO NOTHING`);
      let count = 0;
      for (const row of rows) {
        const createdAt = Date.parse(row.createdAt);
        const closedAt = row.closedAt === null ? null : Date.parse(row.closedAt);
        if (!Number.isSafeInteger(row.id) || row.id <= 0 || !Number.isFinite(createdAt)
          || !['OPEN', 'CLOSED', 'MERGED'].includes(row.status)
          || (closedAt !== null && !Number.isFinite(closedAt))
          || (row.status !== 'OPEN' && (closedAt === null || !Number.isSafeInteger(row.closedById) || row.closedById! <= 0))) {
          throw new Error('invalid Apidog MR snapshot');
        }
        const raw = new TextEncoder().encode(JSON.stringify(row));
        const bodyHash = hash(raw);
        const events: [string, number][] = [['OPENED', createdAt]];
        if (row.status !== 'OPEN') events.push([row.status, closedAt!]);
        for (const [event, timestamp] of events) {
          const prepared = timestamp < cutoff.received_at ? 1 : 0;
          const result = insert.run(`mr-poll:${row.id}:${event}`, `MR_${event}`, raw, bodyHash, timestamp, prepared);
          if (!prepared) count += result.changes;
        }
      }
      return count;
    }).immediate();
  }

  claimUnprepared(now: number, leaseMs: number, selectedLane: DeliveryLane = 'ordinary'): Delivery[] {
    this.checkLease(now, leaseMs);
    return this.db.transaction(() => {
      const cutoff=this.releaseActivation();
      if (selectedLane !== 'ordinary' && cutoff === null) return [];
      const pending = this.db.query<DeliveryRow, [string, number]>(
        `SELECT *, EXISTS(SELECT 1 FROM release_recovery r WHERE r.delivery_id=deliveries.id) AS recovery_allowed FROM deliveries WHERE prepared = 0 AND lane = ?
         AND (lane = 'ordinary' OR received_at >= ? OR id IN (SELECT delivery_id FROM release_recovery)) ORDER BY received_at, id`,
      ).all(selectedLane,cutoff ?? 0);
      const rows: DeliveryRow[] = [];
      const reviewKeys = new Set<string>();
      for (const row of pending) {
        let review;
        try { review = githubReview(delivery(row)); }
        catch { /* Invalid input still reaches preparation and its safe diagnostic. */ }
        if (review) {
          const key = JSON.stringify([review.repository, review.number, review.reviewer]);
          if (reviewKeys.has(key)) continue;
          // Reserve the key even if its earliest source is leased: a later
          // comment must not overtake a source that bridges the same series.
          reviewKeys.add(key);
        }
        if (row.lease_until !== null && row.lease_until > now) continue;
        rows.push(row);
        if (rows.length === CLAIM_LIMIT) break;
      }
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
        (origin_type, origin_id, ordinal, topic, html, button_json, fallback_html, keyboard_json, due_at)
        VALUES ('delivery', ?, ?, ?, ?, ?, ?, ?, ?)`);
      messages.forEach((item, ordinal) => {
        if (item.release && this.db.query('SELECT outbox_id FROM release_notices WHERE notice_key = ?').get(item.release.key)) return;
        const operationKey = item.release?.kind === 'ready' ? item.release.operationKey
          : item.release?.kind === 'result' || item.release?.kind === 'job-error' ? item.release.key : null;
        const previous = operationKey ? this.db.query<{outbox_id:number;metadata_json:string;sending_at:number|null;status:string;error_code:string|null},[string]>(`SELECT n.*,o.status,o.error_code FROM release_notices n
          JOIN outbox o ON o.id=n.outbox_id WHERE operation_key=?`).get(operationKey) : null;
        if (previous) {
          if (item.release?.kind === 'ready' && JSON.parse(previous.metadata_json).kind === 'job-error'
            && previous.sending_at === null && (['pending','leased'].includes(previous.status) || previous.error_code === 'release_skipped')) {
            this.db.query(`UPDATE outbox SET topic=?,html=?,button_json=?,fallback_html=?,keyboard_json=?,status='pending',due_at=?,lease_until=NULL,error_code=NULL WHERE id=?`)
              .run(item.topic,item.html,buttonJson(item),item.fallbackHtml??null,item.keyboard?JSON.stringify(item.keyboard):null,row.received_at,previous.outbox_id);
            this.db.query('UPDATE release_notices SET notice_key=?,metadata_json=?,skip_reason=NULL WHERE outbox_id=?')
              .run(item.release.key,JSON.stringify(item.release),previous.outbox_id);
          }
          return;
        }
        const inserted=insert.run(id, ordinal, item.topic, item.html, buttonJson(item),
          item.fallbackHtml ?? null, item.keyboard ? JSON.stringify(item.keyboard) : null, row.received_at);
        if (item.release) this.db.query('INSERT INTO release_notices (notice_key,operation_key,outbox_id,metadata_json) VALUES (?,?,?,?)').run(item.release.key,operationKey,inserted.lastInsertRowid,JSON.stringify(item.release));
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
        buttonJson(item), item.fallbackHtml ?? null, now));
      return true;
    }).immediate();
  }

  claimDue(now: number, leaseMs: number, limit = CLAIM_LIMIT, lane?: DeliveryLane): DueMessage[] {
    this.checkLease(now, leaseMs);
    return this.db.transaction(() => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > CLAIM_LIMIT) throw new Error('invalid claim limit');
      this.db.query(`UPDATE outbox SET status='failed',lease_until=NULL,error_code='release_uncertain' WHERE status='leased' AND lease_until <= ? AND id IN (SELECT outbox_id FROM release_notices WHERE sending_at IS NOT NULL)`).run(now);
      const rows = this.db.query<OutboxRow, [number, number, DeliveryLane | null, DeliveryLane | null, number]>(`SELECT o.*, n.metadata_json,
        CASE WHEN o.origin_type = 'review_group' THEN 'github' ELSE d.source END AS source
        FROM outbox o LEFT JOIN deliveries d ON o.origin_type = 'delivery' AND o.origin_id = d.id
        LEFT JOIN release_notices n ON n.outbox_id=o.id
        WHERE ((o.status = 'pending' AND o.due_at <= ?) OR (o.status = 'leased' AND o.lease_until <= ?))
        AND (? IS NULL OR COALESCE(d.lane, 'ordinary') = ?)
        ORDER BY o.id LIMIT ?`).all(now, now, lane ?? null, lane ?? null, limit);
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

  renewSendLease(id: number, previousLease: number, now: number, leaseMs: number): boolean {
    this.checkLease(now, leaseMs);
    return this.db.query(`UPDATE outbox SET lease_until=? WHERE id=? AND status='leased' AND lease_until=?
      AND NOT EXISTS (SELECT 1 FROM release_notices WHERE outbox_id=? AND sending_at IS NOT NULL)`)
      .run(now + leaseMs, id, previousLease, id).changes === 1;
  }

  markRetry(id: number, dueAt: number, errorCode: string): void {
    this.db.transaction(() => {
      const updated = this.db.query("UPDATE outbox SET status = 'pending', due_at = ?, lease_until = NULL, error_code = ? WHERE id = ? AND status = 'leased'").run(dueAt, errorCode, id);
      if (updated.changes) this.db.query('UPDATE release_notices SET sending_at=NULL WHERE outbox_id=?').run(id);
    }).immediate();
  }

  markFailed(id: number, errorCode: string): void {
    this.db.query("UPDATE outbox SET status = 'failed', lease_until = NULL, error_code = ? WHERE id = ? AND status = 'leased'").run(errorCode, id);
  }

  useFallback(id: number): void {
    this.db.query("UPDATE outbox SET html = fallback_html, fallback_html = NULL WHERE id = ? AND status = 'leased' AND fallback_html IS NOT NULL").run(id);
  }

  retryFailed(id: number, now: number): boolean {
    return this.db.transaction(()=>{
      const updated=this.db.query("UPDATE outbox SET status = 'pending', due_at = ?, lease_until = NULL, error_code = NULL WHERE id = ? AND status = 'failed' AND error_code IS NOT 'APIDOG_RAW_SUPPRESSED' AND error_code IS NOT 'release_skipped'").run(now, id);
      if (updated.changes) this.db.query('UPDATE release_notices SET sending_at=NULL WHERE outbox_id=?').run(id);
      return updated.changes === 1;
    }).immediate();
  }

  releaseActivation(): number | null {
    return this.db.query<{cutoff_ms:number},[]>('SELECT cutoff_ms FROM release_activation WHERE id=1').get()?.cutoff_ms ?? null;
  }

  activateReleases(cutoffMs: number): void {
    if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) throw new Error('invalid release activation');
    this.db.transaction(()=>{
      const old=this.releaseActivation();
      if (old !== null && old !== cutoffMs) throw new Error('release activation is immutable');
      this.db.query('INSERT OR IGNORE INTO release_activation (id,cutoff_ms) VALUES (1,?)').run(cutoffMs);
      this.db.query("UPDATE deliveries SET prepared=1,lease_until=NULL WHERE lane != 'ordinary' AND received_at < ? AND id NOT IN (SELECT delivery_id FROM release_recovery)").run(cutoffMs);
    }).immediate();
  }

  recoverReleaseDelivery(id: number): boolean {
    return this.db.transaction(()=>{
      const row=this.db.query<DeliveryRow,[number]>("SELECT * FROM deliveries WHERE id=? AND source='github' AND lane != 'ordinary'").get(id);
      if (!row) return false;
      this.db.query('INSERT OR IGNORE INTO release_recovery (delivery_id) VALUES (?)').run(id);
      this.db.query('UPDATE deliveries SET prepared=0,lease_until=NULL WHERE id=?').run(id);
      return true;
    }).immediate();
  }

  beginReleaseSend(id: number, now: number): boolean {
    return this.db.query(`UPDATE release_notices SET sending_at=? WHERE outbox_id=? AND sending_at IS NULL
      AND outbox_id IN (SELECT id FROM outbox WHERE status='leased' AND lease_until > ?)`)
      .run(now,id,now).changes === 1;
  }

  skipRelease(id: number, reason: string): void {
    if (!/^[a-z_]{1,64}$/.test(reason)) throw new Error('invalid skip reason');
    this.db.transaction(()=>{
      this.markFailed(id,'release_skipped');
      this.db.query('UPDATE release_notices SET skip_reason=? WHERE outbox_id=?').run(reason,id);
    }).immediate();
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
      if (version > 3) throw new Error('unsupported database schema');
      if (version === 0) {
        db.exec(schema);
      }
      if (version < 2) {
        db.exec(reviewSchema);
        db.exec('PRAGMA user_version = 2');
      }
      if (version < 3) {
        db.exec(releaseSchema);
        db.exec('PRAGMA user_version = 3');
      }
    }).immediate();
    return new Store(db);
  } catch (error) {
    db.close();
    throw error;
  }
}
