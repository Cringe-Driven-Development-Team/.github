import { Database } from 'bun:sqlite';
import type { Context, Input } from './commands';
import type { Issue } from './github';
import type { Outgoing } from './messages';

export type Phase = 'received' | 'waiting_repo' | 'ready' | 'creating' | 'issue_created' | 'mutating' | 'reply_pending' | 'done' | 'uncertain';
export interface Job {
  id: number;
  input: Input;
  phase: Phase;
  issue?: Issue;
  output?: Outgoing[];
  nextOutput: number;
  nextAttemptAt: number;
  attempts: number;
  selectedRepo?: string;
  choiceId?: string;
}
type Patch = Partial<Pick<Job, 'phase' | 'issue' | 'output' | 'nextOutput' | 'nextAttemptAt' | 'attempts' | 'selectedRepo' | 'choiceId'>>;
export interface Store {
  ingest(inputs: Input[], nextOffset: number): void;
  offset(): number;
  job(id: number): Job;
  nextJob(now: number): Job | null;
  checkpoint(id: number, patch: Patch): void;
  createChoice(jobId: number, repoNames: string[], expiresAt: number): string;
  choiceRepositories(requestId: string): string[];
  bindPrompt(requestId: string, messageId: number): void;
  choose(requestId: string, actorId: string, context: Context, promptMessageId: number, repoIndex: number, now: number): number;
  blockAlias(id: string, configuredUsername: string): void;
  isAliasBlocked(id: string, configuredUsername: string): boolean;
  recover(): void;
  close(): void;
}

interface Row {
  id: number; input: string; phase: Phase; issue: string | null; output: string | null;
  next_output: number; next_attempt_at: number; attempts: number; selected_repo: string | null; choice_id: string | null;
}
interface Choice {
  id: string; job_id: number; owner: string; chat_id: string; thread_id: number | null;
  prompt_id: number | null; repositories: string; expires_at: number; selected_index: number | null;
}
const decode = (row: Row): Job => ({
  id: row.id, input: JSON.parse(row.input), phase: row.phase,
  ...(row.issue === null ? {} : { issue: JSON.parse(row.issue) }),
  ...(row.output === null ? {} : { output: JSON.parse(row.output) }),
  nextOutput: row.next_output, nextAttemptAt: row.next_attempt_at, attempts: row.attempts,
  ...(row.selected_repo === null ? {} : { selectedRepo: row.selected_repo }),
  ...(row.choice_id === null ? {} : { choiceId: row.choice_id }),
});

export function openStore(path: string): Store {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY, input TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'received',
      issue TEXT, output TEXT, next_output INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      selected_repo TEXT, choice_id TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK (id = 1), offset INTEGER NOT NULL);
    INSERT OR IGNORE INTO cursor VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS choices (
      id TEXT PRIMARY KEY, job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
      owner TEXT NOT NULL, chat_id TEXT NOT NULL, thread_id INTEGER, prompt_id INTEGER,
      repositories TEXT NOT NULL, expires_at INTEGER NOT NULL, selected_index INTEGER
    );
    CREATE TABLE IF NOT EXISTS blocked_aliases (
      id TEXT NOT NULL, username TEXT NOT NULL, PRIMARY KEY (id, username)
    );
  `);
  const job = (id: number): Job => {
    const row = db.query<Row, [number]>('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!row) throw new Error('Unknown bot job');
    return decode(row);
  };
  const checkpoint = db.transaction((id: number, patch: Patch): void => {
    const current = job(id);
    if (current.phase === 'uncertain' && patch.phase !== undefined && !['uncertain', 'done'].includes(patch.phase)) {
      throw new Error('Uncertain creation cannot be retried');
    }
    const next = { ...current, ...patch };
    db.query(`UPDATE jobs SET phase = ?, issue = ?, output = ?, next_output = ?, next_attempt_at = ?,
      attempts = ?, selected_repo = ?, choice_id = ? WHERE id = ?`).run(
      next.phase, next.issue === undefined ? null : JSON.stringify(next.issue),
      next.output === undefined ? null : JSON.stringify(next.output), next.nextOutput, next.nextAttemptAt,
      next.attempts, next.selectedRepo ?? null, next.choiceId ?? null, id,
    );
  });
  const savedChoice = (id: string): Choice => {
    const row = db.query<Choice, [string]>('SELECT * FROM choices WHERE id = ?').get(id);
    if (!row) throw new Error('Unknown repository choice');
    return row;
  };
  return {
    ingest: db.transaction((inputs: Input[], nextOffset: number): void => {
      for (const input of inputs) db.query('INSERT OR IGNORE INTO jobs (id, input) VALUES (?, ?)').run(input.updateId, JSON.stringify(input));
      db.query('UPDATE cursor SET offset = MAX(offset, ?) WHERE id = 1').run(nextOffset);
    }).immediate,
    offset: () => db.query<{ offset: number }, []>('SELECT offset FROM cursor WHERE id = 1').get()!.offset,
    job,
    nextJob(now) {
      const row = db.query<Row, [number]>(`SELECT * FROM jobs WHERE next_attempt_at <= ?
        AND phase NOT IN ('waiting_repo', 'done')
        AND (phase != 'uncertain' OR next_output < COALESCE(json_array_length(output), 0))
        ORDER BY id LIMIT 1`).get(now);
      return row ? decode(row) : null;
    },
    checkpoint: checkpoint.immediate,
    createChoice: db.transaction((jobId: number, repoNames: string[], expiresAt: number): string => {
      const original = job(jobId);
      if (original.choiceId) return original.choiceId;
      if (original.input.kind !== 'command' || original.input.command.name !== 'issue'
        || !['received', 'ready'].includes(original.phase) || !repoNames.length || repoNames.some(name => !name)) {
        throw new Error('Invalid repository choice request');
      }
      const id = crypto.randomUUID();
      db.query(`INSERT INTO choices (id, job_id, owner, chat_id, thread_id, repositories, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, jobId, original.input.actor.id, original.input.context.chatId,
        original.input.context.threadId ?? null, JSON.stringify(repoNames), expiresAt);
      checkpoint(jobId, { choiceId: id });
      return id;
    }).immediate,
    choiceRepositories: requestId => JSON.parse(savedChoice(requestId).repositories),
    bindPrompt: db.transaction((requestId: string, messageId: number): void => {
      const choice = savedChoice(requestId);
      if (!Number.isSafeInteger(messageId) || messageId <= 0 || (choice.prompt_id !== null && choice.prompt_id !== messageId)) {
        throw new Error('Invalid repository choice prompt');
      }
      db.query('UPDATE choices SET prompt_id = ? WHERE id = ?').run(messageId, requestId);
    }).immediate,
    choose: db.transaction((requestId: string, actorId: string, context: Context, promptMessageId: number, repoIndex: number, now: number): number => {
      const choice = savedChoice(requestId);
      const repos: string[] = JSON.parse(choice.repositories);
      if (choice.owner !== actorId || choice.chat_id !== context.chatId || choice.thread_id !== (context.threadId ?? null)
        || choice.prompt_id === null || choice.prompt_id !== promptMessageId || !Number.isFinite(now) || now >= choice.expires_at
        || !Number.isSafeInteger(repoIndex) || repoIndex < 0 || repoIndex >= repos.length) {
        throw new Error('Invalid or expired repository choice');
      }
      if (choice.selected_index !== null) return choice.job_id;
      if (job(choice.job_id).phase !== 'waiting_repo') throw new Error('Repository choice is not awaiting selection');
      db.query('UPDATE choices SET selected_index = ? WHERE id = ?').run(repoIndex, requestId);
      checkpoint(choice.job_id, { selectedRepo: repos[repoIndex]!, phase: 'ready' });
      return choice.job_id;
    }).immediate,
    blockAlias(id, configuredUsername) {
      db.query('INSERT OR IGNORE INTO blocked_aliases (id, username) VALUES (?, ?)').run(id, configuredUsername);
    },
    isAliasBlocked: (id, configuredUsername) => db.query('SELECT 1 FROM blocked_aliases WHERE id = ? AND username = ?').get(id, configuredUsername) !== null,
    recover: db.transaction((): void => {
      const interrupted = db.query<Row, []>("SELECT * FROM jobs WHERE phase IN ('creating', 'mutating')").all();
      for (const row of interrupted) {
        if (row.phase === 'mutating') checkpoint(row.id, { phase: 'ready' });
        else if (row.issue !== null) checkpoint(row.id, { phase: 'issue_created' });
        else checkpoint(row.id, { phase: 'uncertain', output: [{ html: 'Результат создания issue в GitHub неизвестен. Проверьте репозиторий вручную; GitHubBot не будет повторять создание.' }],
          nextOutput: 0, nextAttemptAt: 0 });
      }
    }).immediate,
    close: () => db.close(),
  };
}
