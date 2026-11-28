import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { githubReview } from './github';

export type DeliveryLane = 'ordinary' | 'release-queue' | 'release-operation';
export type ReleaseNotice = { key: string; repository?: string; action?: 'deploy'|'rollback'; attempt?: number } & (
  {kind:'queue';prNumber:number;queueEntryId:string} | {kind:'dequeue';prNumber:number} |
  {kind:'ready';sha:string;operationKey:string;releaseId?:number} | {kind:'start'|'result';deploymentId:number;runId:number} |
  {kind:'result';repository:typeof INFRA_REPO;runId:number;attempt:number;jobId:number;deploymentId?:number} |
  {kind:'job-error'|'retention';runId:number;attempt:number;jobId:number}
);

export type AcceptResult = 'accepted' | 'duplicate' | 'conflict';

export interface DeliveryInput {
  source: 'github';
  deliveryId: string;
  event: string;
  raw: Uint8Array;
  receivedAt?: number;
}

export interface Delivery extends DeliveryInput {
  id: number;
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
  return item.button ? JSON.stringify(item.button) : null;
}

function message(row: OutboxRow): DueMessage {
  if (row.source !== 'github') throw new Error('outbox origin has no source');
  const button = row.button_json === null ? undefined : JSON.parse(row.button_json) as OutgoingMessage['button'];
  return {
    id: row.id, source: row.source, originType: row.origin_type, originId: row.origin_id, ordinal: row.ordinal,
    topic: row.topic, html: row.html,
    ...(button ? { button: { text: button.text, url: button.url } } : {}),
    ...(row.fallback_html === null ? {} : { fallbackHtml: row.fallback_html }),
    ...(row.keyboard_json ? {keyboard:JSON.parse(row.keyboard_json)} : {}),
    ...(row.metadata_json ? {release:JSON.parse(row.metadata_json)} : {}),
    status: 'leased', attempts: row.attempts, dueAt: row.due_at, leaseUntil: row.lease_until,
  };
}

function hash(raw: Uint8Array): string {
  return createHash('sha256').update(raw).digest('hex');
}

const CLAIM_LIMIT = 10;
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const deliveriesSchema = readFileSync(new URL('./deliveries-schema.sql', import.meta.url), 'utf8');
const releaseSchema = readFileSync(new URL('./release-schema.sql', import.meta.url), 'utf8');

export const INFRA_REPO = 'Cringe-Driven-Development-Team/infra';
const frontendRepo = 'Cringe-Driven-Development-Team/frontend';
const releaseActivationTables = new Map([
  [frontendRepo, 'release_activation'],
  ['Cringe-Driven-Development-Team/backend', 'backend_release_activation'],
  [INFRA_REPO, 'infra_release_activation'],
]);

function lane(input: DeliveryInput): DeliveryLane {
  try {
    const payload=JSON.parse(new TextDecoder().decode(input.raw));
    const repository = payload?.repository?.full_name;
    if (!releaseActivationTables.has(repository)) return 'ordinary';
    if (repository === frontendRepo && input.event === 'pull_request' && ['enqueued','dequeued'].includes(payload.action)) return 'release-queue';
    if (['deployment_status','workflow_job'].includes(input.event) || ([frontendRepo, 'Cringe-Driven-Development-Team/backend'].includes(repository) && input.event === 'release')) return 'release-operation';
  } catch { /* Other accepted events retain their original preparation path. */ }
  return 'ordinary';
}

const reviewSchema = readFileSync(new URL('./review-groups-schema.sql', import.meta.url), 'utf8');

export class Store {
  constructor(
    private readonly db: Database,
    private readonly pausedReleaseRepository: string | null = null,
  ) {}

  accept(input: DeliveryInput): AcceptResult {
    if (!input.deliveryId?.trim()) throw new Error('delivery ID required');
    const bodyHash = hash(input.raw);
    const receivedAt = input.receivedAt ?? Date.now();
    return this.db.transaction((): AcceptResult => {
      const existing = this.db.query<{ body_hash: string }, [string]>(
        "SELECT body_hash FROM deliveries WHERE source = 'github' AND delivery_id = ?",
      ).get(input.deliveryId);
      if (existing) return existing.body_hash === bodyHash ? 'duplicate' : 'conflict';
      this.db.query(`INSERT INTO deliveries
        (source, delivery_id, event, raw, body_hash, received_at, lane)
        VALUES ('github', ?, ?, ?, ?, ?, ?)`).run(input.deliveryId, input.event, input.raw, bodyHash, receivedAt, lane(input));
      return 'accepted';
    }).immediate();
  }

  claimUnprepared(now: number, leaseMs: number, selectedLane: DeliveryLane = 'ordinary'): Delivery[] {
    this.checkLease(now, leaseMs);
    return this.db.transaction(() => {

      const pending = this.db.query<DeliveryRow, [string]>(
        `SELECT *, EXISTS(SELECT 1 FROM release_recovery r WHERE r.delivery_id=deliveries.id) AS recovery_allowed FROM deliveries WHERE prepared = 0 AND lane = ?
         ORDER BY received_at, id`,
      ).all(selectedLane);
      const rows: DeliveryRow[] = [];
      const reviewKeys = new Set<string>();
      for (const row of pending) {
        if (selectedLane !== 'ordinary') {
          const repository = JSON.parse(new TextDecoder().decode(row.raw)).repository?.full_name;
          if (repository === this.pausedReleaseRepository) continue;
          const cutoff = this.releaseActivation(repository);
          if (cutoff === null || (row.received_at < cutoff && !row.recovery_allowed)) continue;
        }
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
        const operationKey = item.release?.kind === 'ready' ? item.release.operationKey
          : item.release?.kind === 'result' || item.release?.kind === 'job-error' ? item.release.key : null;
        const previous = operationKey ? this.db.query<{outbox_id:number;metadata_json:string;sending_at:number|null;status:string;error_code:string|null},[string]>(`SELECT n.*,o.status,o.error_code FROM release_notices n
          JOIN outbox o ON o.id=n.outbox_id WHERE operation_key=?`).get(operationKey) : null;
        if (previous) {
          if ((item.release?.kind === 'ready' || item.release?.kind === 'result') && JSON.parse(previous.metadata_json).kind === 'job-error'
            && previous.sending_at === null && (['pending','leased'].includes(previous.status) || previous.error_code === 'release_skipped')) {
            this.db.query(`UPDATE outbox SET topic=?,html=?,button_json=?,fallback_html=?,keyboard_json=?,status='pending',due_at=?,lease_until=NULL,error_code=NULL WHERE id=?`)
              .run(item.topic,item.html,buttonJson(item),item.fallbackHtml??null,item.keyboard?JSON.stringify(item.keyboard):null,row.received_at,previous.outbox_id);
            this.db.query('UPDATE release_notices SET notice_key=?,metadata_json=?,skip_reason=NULL WHERE outbox_id=?')
              .run(item.release.key,JSON.stringify(item.release),previous.outbox_id);
          }
          return;
        }
        if (item.release && this.db.query('SELECT outbox_id FROM release_notices WHERE notice_key = ?').get(item.release.key)) return;
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
      const paused = this.pausedReleaseRepository;
      this.db.query(`UPDATE outbox SET status='failed',lease_until=NULL,error_code='release_uncertain'
        WHERE status='leased' AND lease_until <= ? AND id IN (
          SELECT outbox_id FROM release_notices WHERE sending_at IS NOT NULL
          AND (? IS NULL OR json_extract(metadata_json, '$.repository') IS NOT ?)
        )`).run(now, paused, paused);
      const rows = this.db.query<OutboxRow, [number, number, DeliveryLane | null, DeliveryLane | null, string | null, string | null, number]>(`SELECT o.*, n.metadata_json,
        CASE WHEN o.origin_type = 'review_group' THEN 'github' ELSE d.source END AS source
        FROM outbox o LEFT JOIN deliveries d ON o.origin_type = 'delivery' AND o.origin_id = d.id
        LEFT JOIN release_notices n ON n.outbox_id=o.id
        WHERE ((o.status = 'pending' AND o.due_at <= ?) OR (o.status = 'leased' AND o.lease_until <= ?))
        AND (? IS NULL OR COALESCE(d.lane, 'ordinary') = ?)
        AND (? IS NULL OR json_extract(n.metadata_json, '$.repository') IS NOT ?)
        AND NOT EXISTS (
          SELECT 1 FROM release_notices start_notice JOIN outbox start_card ON start_card.id = start_notice.outbox_id
          WHERE n.notice_key GLOB 'result:${INFRA_REPO}:*'
            AND start_notice.notice_key = 'start:' || substr(n.notice_key, length('result:') + 1)
            AND start_card.status IN ('pending', 'leased')
        )
        ORDER BY o.id LIMIT ?`).all(now, now, lane ?? null, lane ?? null, paused, paused, limit);
      const leaseUntil = now + leaseMs;
      for (const row of rows) {
        this.db.query("UPDATE outbox SET status = 'leased', attempts = attempts + 1, lease_until = ? WHERE id = ?").run(leaseUntil, row.id);
        row.attempts++;
        row.lease_until = leaseUntil;
      }
      return rows.map(message);
    }).immediate();
  }

  refreshReleaseMessage(id: number, leaseUntil: number, card: OutgoingMessage): boolean {
    if (!card.release) return false;
    return this.db.transaction(() => {
      const updated = this.db.query(`UPDATE outbox SET topic=?,html=?,button_json=?,fallback_html=?,keyboard_json=?
        WHERE id=? AND status='leased' AND lease_until=? AND EXISTS
        (SELECT 1 FROM release_notices WHERE outbox_id=? AND notice_key=? AND sending_at IS NULL)`)
        .run(card.topic,card.html,buttonJson(card),card.fallbackHtml??null,card.keyboard?JSON.stringify(card.keyboard):null,id,leaseUntil,id,card.release!.key);
      if (!updated.changes) return false;
      this.db.query('UPDATE release_notices SET metadata_json=? WHERE outbox_id=?').run(JSON.stringify(card.release),id);
      return true;
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
      const updated=this.db.query("UPDATE outbox SET status = 'pending', due_at = ?, lease_until = NULL, error_code = NULL WHERE id = ? AND status = 'failed' AND error_code IS NOT 'release_skipped'").run(now, id);
      if (updated.changes) this.db.query('UPDATE release_notices SET sending_at=NULL WHERE outbox_id=?').run(id);
      return updated.changes === 1;
    }).immediate();
  }

  releaseActivation(repository = frontendRepo): number | null {
    const table = releaseActivationTables.get(repository);
    if (!table) return null;
    return this.db.query<{cutoff_ms:number},[]>(`SELECT cutoff_ms FROM ${table} WHERE id=1`).get()?.cutoff_ms ?? null;
  }

  activateReleases(cutoffMs: number, repository = frontendRepo): void {
    const table = releaseActivationTables.get(repository);
    if (!table) throw new Error('invalid release repository');
    if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) throw new Error('invalid release activation');
    this.db.transaction(()=>{
      const old=this.releaseActivation(repository);
      if (old !== null && old !== cutoffMs) throw new Error('release activation is immutable');
      this.db.query(`INSERT OR IGNORE INTO ${table} (id,cutoff_ms) VALUES (1,?)`).run(cutoffMs);
      this.db.query("UPDATE deliveries SET prepared=1,lease_until=NULL WHERE lane != 'ordinary' AND received_at < ? AND json_extract(CAST(raw AS TEXT),'$.repository.full_name') = ? AND id NOT IN (SELECT delivery_id FROM release_recovery)").run(cutoffMs,repository);
    }).immediate();
  }

  releaseContract(): number | null {
    return this.db.query<{cutoff_ms:number},[]>('SELECT cutoff_ms FROM release_contract WHERE id=1').get()?.cutoff_ms ?? null;
  }

  activateReleaseContract(cutoffMs: number): void {
    if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) throw new Error('invalid release contract');
    this.db.transaction(()=>{
      const old=this.releaseContract();
      if (old !== null && old !== cutoffMs) throw new Error('release contract is immutable');
      this.db.query('INSERT OR IGNORE INTO release_contract (id,cutoff_ms) VALUES (1,?)').run(cutoffMs);
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

export function openStore(path: string, { infraReleasesEnabled = true }: { infraReleasesEnabled?: boolean } = {}): Store {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec('PRAGMA busy_timeout = 1000');
    db.exec('PRAGMA journal_mode = WAL');
    // WAL + FULL syncs every acknowledged commit, including across a power failure.
    db.exec('PRAGMA synchronous = FULL');
    // Replacing the parent table requires suspending enforcement on this connection.
    db.exec('PRAGMA foreign_keys = OFF');
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
      if (version === 8) return;
      if (version !== 0 && version !== 6 && version !== 7) throw new Error('unsupported database schema');

      db.exec(deliveriesSchema);
      if (version !== 0) {
        db.exec(`
          INSERT INTO deliveries_next (id, source, delivery_id, event, raw, body_hash, received_at, prepared, lease_until, lane)
            SELECT id, source, delivery_id, event, raw, body_hash, received_at, prepared, lease_until, lane FROM deliveries;
          DROP TABLE deliveries;
        `);
      }
      db.exec(`
        ALTER TABLE deliveries_next RENAME TO deliveries;
        CREATE INDEX deliveries_unprepared ON deliveries (prepared, lease_until, id);
      `);

      if (version === 0) {
        db.exec(schema);
        db.exec(reviewSchema);
        db.exec(releaseSchema);
        db.exec(`
          CREATE TABLE release_contract (id INTEGER PRIMARY KEY CHECK (id=1), cutoff_ms INTEGER NOT NULL);
          CREATE TABLE backend_release_activation (id INTEGER PRIMARY KEY CHECK (id=1), cutoff_ms INTEGER NOT NULL);
        `);
      }
      if (version === 0 || version === 6) {
        db.exec('CREATE TABLE infra_release_activation (id INTEGER PRIMARY KEY CHECK (id=1), cutoff_ms INTEGER NOT NULL)');
      }
      if (db.query('PRAGMA foreign_key_check').get()) throw new Error('database migration violates foreign keys');
      db.exec('PRAGMA user_version = 8');
    }).immediate();
    db.exec('PRAGMA foreign_keys = ON');
    return new Store(db, infraReleasesEnabled ? null : INFRA_REPO);
  } catch (error) {
    db.close();
    throw error;
  }
}
