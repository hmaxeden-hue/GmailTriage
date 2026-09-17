import type {
  DraftStore,
  MessageStore,
  NotificationStore,
  RunStore,
  TriageStore,
} from '../../core/ports.js';
import type { DraftRecord, NormalizedMessage, TriageRecord } from '../../core/types.js';
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

interface TriageRow {
  message_id: string;
  classification: TriageRecord['classification'];
  urgency: TriageRecord['urgency'];
  urgency_source: TriageRecord['urgencySource'];
  sender_name: string | null;
  contact: string | null;
  location: string | null;
  service: string | null;
  desired_date: string | null;
  object_info: string | null;
  budget_hint: string | null;
  missing_fields_json: string;
  status: 'needs_human_review';
  confidence: number;
  reasoning: string | null;
  provider: string;
  model: string;
  prompt_version: string;
  repair_used: number;
  created_at: number;
}

function toTriage(r: TriageRow): TriageRecord {
  return {
    messageId: r.message_id,
    classification: r.classification,
    urgency: r.urgency,
    urgencySource: r.urgency_source,
    senderName: r.sender_name,
    contact: r.contact,
    location: r.location,
    service: r.service,
    desiredDate: r.desired_date,
    objectInfo: r.object_info,
    budgetHint: r.budget_hint,
    missingFields: JSON.parse(r.missing_fields_json) as string[],
    status: r.status,
    confidence: r.confidence,
    reasoning: r.reasoning,
    provider: r.provider,
    model: r.model,
    promptVersion: r.prompt_version,
    repairUsed: r.repair_used === 1,
    createdAt: r.created_at,
  };
}

/** Triage-Ergebnisse werden angehaengt, nie ueberschrieben — die Historie bleibt lesbar. */
export class SqliteTriageStore implements TriageStore {
  constructor(private readonly db: Db) {}

  insertTriage(t: TriageRecord): number {
    const info = this.db
      .prepare(
        `INSERT INTO triage_results (message_id, classification, urgency, urgency_source,
           sender_name, contact, location, service, desired_date, object_info, budget_hint,
           missing_fields_json, status, confidence, reasoning, provider, model,
           prompt_version, repair_used, created_at)
         VALUES (@message_id, @classification, @urgency, @urgency_source,
           @sender_name, @contact, @location, @service, @desired_date, @object_info, @budget_hint,
           @missing_fields_json, @status, @confidence, @reasoning, @provider, @model,
           @prompt_version, @repair_used, @created_at)`,
      )
      .run({
        message_id: t.messageId,
        classification: t.classification,
        urgency: t.urgency,
        urgency_source: t.urgencySource,
        sender_name: t.senderName,
        contact: t.contact,
        location: t.location,
        service: t.service,
        desired_date: t.desiredDate,
        object_info: t.objectInfo,
        budget_hint: t.budgetHint,
        missing_fields_json: JSON.stringify(t.missingFields),
        status: t.status,
        confidence: t.confidence,
        reasoning: t.reasoning,
        provider: t.provider,
        model: t.model,
        prompt_version: t.promptVersion,
        repair_used: t.repairUsed ? 1 : 0,
        created_at: t.createdAt,
      });
    return Number(info.lastInsertRowid);
  }

  latestTriage(messageId: string): TriageRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM triage_results WHERE message_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(messageId) as TriageRow | undefined;
    return row ? toTriage(row) : null;
  }

  listTriage(since: Date): TriageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM triage_results t
         JOIN messages m ON m.message_id = t.message_id
         WHERE m.internal_date >= ?
           AND t.id = (SELECT MAX(id) FROM triage_results x WHERE x.message_id = t.message_id)
         ORDER BY m.internal_date DESC`,
      )
      .all(since.getTime()) as TriageRow[];
    return rows.map(toTriage);
  }
}

interface DraftRow {
  message_id: string;
  thread_id: string;
  gmail_draft_id: string | null;
  kind: DraftRecord['kind'];
  body: string;
  dry_run: number;
  created_at: number;
}

function toDraft(r: DraftRow): DraftRecord {
  return {
    messageId: r.message_id,
    threadId: r.thread_id,
    gmailDraftId: r.gmail_draft_id,
    kind: r.kind,
    body: r.body,
    dryRun: r.dry_run === 1,
    createdAt: r.created_at,
  };
}

export class SqliteDraftStore implements DraftStore {
  constructor(private readonly db: Db) {}

  /** INSERT OR IGNORE gegen den Primaerschluessel — hier sitzt die Idempotenz. */
  insertDraft(d: DraftRecord): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO drafts
           (message_id, thread_id, gmail_draft_id, kind, body, dry_run, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.messageId,
        d.threadId,
        d.gmailDraftId,
        d.kind,
        d.body,
        d.dryRun ? 1 : 0,
        d.createdAt,
      );
    return info.changes > 0;
  }

  replaceDryRunDraft(d: DraftRecord): boolean {
    const info = this.db
      .prepare(
        `UPDATE drafts
            SET gmail_draft_id = ?, kind = ?, body = ?, dry_run = 0, created_at = ?
          WHERE message_id = ? AND dry_run = 1`,
      )
      .run(d.gmailDraftId, d.kind, d.body, d.createdAt, d.messageId);
    return info.changes > 0;
  }

  getDraft(messageId: string): DraftRecord | null {
    const row = this.db.prepare('SELECT * FROM drafts WHERE message_id = ?').get(messageId) as
      | DraftRow
      | undefined;
    return row ? toDraft(row) : null;
  }
}

/** Der Primaerschluessel (message_id, channel) verhindert doppelte Pushes. */
export class SqliteNotificationStore implements NotificationStore {
  constructor(private readonly db: Db) {}

  markNotified(messageId: string, channel: string, sentAt: number, dryRun: boolean): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO notifications (message_id, channel, sent_at, dry_run)
         VALUES (?, ?, ?, ?)`,
      )
      .run(messageId, channel, sentAt, dryRun ? 1 : 0);
    return info.changes > 0;
  }

  wasNotified(messageId: string, channel: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS hit FROM notifications WHERE message_id = ? AND channel = ?')
      .get(messageId, channel) as { hit: number } | undefined;
    return row !== undefined;
  }
}
