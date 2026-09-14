import type { MessageStore, RunStore } from '../../core/ports.js';
import type { NormalizedMessage } from '../../core/types.js';
import type { Db } from './db.js';

interface MessageRow {
  message_id: string;
  thread_id: string;
  rfc822_id: string | null;
  from_name: string | null;
  from_email: string;
  to_email: string | null;
  subject: string | null;
  internal_date: number;
  body_text: string;
  signature_text: string | null;
  body_hash: string;
  labels_json: string;
  truncated: number;
  ingested_at: number;
}

function toMessage(r: MessageRow): NormalizedMessage {
  return {
    messageId: r.message_id,
    threadId: r.thread_id,
    rfc822Id: r.rfc822_id,
    fromName: r.from_name,
    fromEmail: r.from_email,
    toEmail: r.to_email,
    subject: r.subject,
    internalDate: r.internal_date,
    bodyText: r.body_text,
    signatureText: r.signature_text,
    bodyHash: r.body_hash,
    labelIds: JSON.parse(r.labels_json) as string[],
    truncated: r.truncated === 1,
    ingestedAt: r.ingested_at,
  };
}

export class SqliteStore implements MessageStore, RunStore {
  constructor(private readonly db: Db) {}

  upsertMessage(m: NormalizedMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages (message_id, thread_id, rfc822_id, from_name, from_email,
           to_email, subject, internal_date, body_text, signature_text, body_hash,
           labels_json, truncated, ingested_at)
         VALUES (@message_id, @thread_id, @rfc822_id, @from_name, @from_email,
           @to_email, @subject, @internal_date, @body_text, @signature_text, @body_hash,
           @labels_json, @truncated, @ingested_at)
         ON CONFLICT(message_id) DO UPDATE SET
           body_text = excluded.body_text,
           signature_text = excluded.signature_text,
           body_hash = excluded.body_hash,
           labels_json = excluded.labels_json,
           truncated = excluded.truncated,
           ingested_at = excluded.ingested_at`,
      )
      .run({
        message_id: m.messageId,
        thread_id: m.threadId,
        rfc822_id: m.rfc822Id,
        from_name: m.fromName,
        from_email: m.fromEmail,
        to_email: m.toEmail,
        subject: m.subject,
        internal_date: m.internalDate,
        body_text: m.bodyText,
        signature_text: m.signatureText,
        body_hash: m.bodyHash,
        labels_json: JSON.stringify(m.labelIds),
        truncated: m.truncated ? 1 : 0,
        ingested_at: m.ingestedAt,
      });
  }

  hasMessage(messageId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS hit FROM messages WHERE message_id = ?')
      .get(messageId) as { hit: number } | undefined;
    return row !== undefined;
  }

  getMessage(messageId: string): NormalizedMessage | null {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .get(messageId) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  listMessages(since: Date): NormalizedMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE internal_date >= ? ORDER BY internal_date DESC')
      .all(since.getTime()) as MessageRow[];
    return rows.map(toMessage);
  }

  countMessages(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    return row.n;
  }

  startRun(r: { startedAt: number; sinceArg: string; writeMode: boolean; model: string | null }): number {
    const info = this.db
      .prepare(
        `INSERT INTO runs (started_at, since_arg, write_mode, model)
         VALUES (?, ?, ?, ?)`,
      )
      .run(r.startedAt, r.sinceArg, r.writeMode ? 1 : 0, r.model);
    return Number(info.lastInsertRowid);
  }

  finishRun(id: number, r: { finishedAt: number; counts: Record<string, number>; exitCode: number }): void {
    this.db
      .prepare('UPDATE runs SET finished_at = ?, counts_json = ?, exit_code = ? WHERE id = ?')
      .run(r.finishedAt, JSON.stringify(r.counts), r.exitCode, id);
  }
}
