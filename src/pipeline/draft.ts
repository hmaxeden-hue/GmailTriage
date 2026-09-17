import type { ProfileConfig } from '../config/schema.js';
import type { DraftSink, DraftStore, LabelSink } from '../core/ports.js';
import { buildDraft, needsDraft, type DraftText } from '../core/reply.js';
import type { DraftRecord, NormalizedMessage, TriageRecord } from '../core/types.js';

export type DraftOutcome =
  | { kind: 'erstellt'; draft: DraftRecord; text: DraftText }
  | { kind: 'vorhanden'; draft: DraftRecord }
  | { kind: 'nicht_noetig'; reason: string }
  | { kind: 'fehlgeschlagen'; error: string };

export interface DraftResult {
  outcomes: Array<{ message: NormalizedMessage; outcome: DraftOutcome }>;
  counts: Record<string, number>;
}

export interface DraftDeps {
  sink: DraftSink;
  store: DraftStore;
  profile: ProfileConfig;
  /** Absenderadresse im From-Header des Entwurfs. */
  from: string;
  /** false: nichts bei Gmail anlegen, nur den Text berechnen und ablegen. */
  write: boolean;
  /** Optionales Label; null bedeutet: keins setzen. */
  label: string | null;
  labelSink: LabelSink;
  now: () => number;
}

/**
 * Erzeugt hoechstens einen Entwurf pro Mail. Die Sperre liegt in SQLite:
 * drafts.message_id ist Primaerschluessel, und die Zeile wird geschrieben,
 * bevor Gmail angefragt wird.
 */
export async function draftForMessage(
  message: NormalizedMessage,
  triage: TriageRecord,
  deps: DraftDeps,
): Promise<DraftOutcome> {
  if (!needsDraft(triage)) {
    return { kind: 'nicht_noetig', reason: `classification=${triage.classification}` };
  }

  const existing = deps.store.getDraft(message.messageId);
  if (existing) {
    // Ein Dry-Run-Eintrag darf zum echten Entwurf nachgezogen werden.
    if (!(existing.dryRun && deps.write)) return { kind: 'vorhanden', draft: existing };
  }

  const text = buildDraft(message, triage, deps.profile);

  if (!deps.write) {
    const record: DraftRecord = {
      messageId: message.messageId,
      threadId: message.threadId,
      gmailDraftId: null,
      kind: text.kind,
      body: text.body,
      dryRun: true,
      createdAt: deps.now(),
    };
    deps.store.insertDraft(record);
    return { kind: 'erstellt', draft: record, text };
  }

  try {
    const { draftId } = await deps.sink.createReplyDraft({
      threadId: message.threadId,
      inReplyTo: message.rfc822Id,
      to: message.fromEmail,
      subject: text.subject,
      body: text.body,
    });

    const record: DraftRecord = {
      messageId: message.messageId,
      threadId: message.threadId,
      gmailDraftId: draftId,
      kind: text.kind,
      body: text.body,
      dryRun: false,
      createdAt: deps.now(),
    };

    if (existing?.dryRun) deps.store.replaceDryRunDraft(record);
    else deps.store.insertDraft(record);

    if (deps.label) await deps.labelSink.addLabel(message.messageId, deps.label);
    return { kind: 'erstellt', draft: record, text };
  } catch (err: unknown) {
    return { kind: 'fehlgeschlagen', error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runDrafts(
  items: Array<{ message: NormalizedMessage; triage: TriageRecord }>,
  deps: DraftDeps,
): Promise<DraftResult> {
  const outcomes: DraftResult['outcomes'] = [];
  const counts: Record<string, number> = {
    erstellt: 0,
    vorhanden: 0,
    nicht_noetig: 0,
    fehlgeschlagen: 0,
  };

  for (const { message, triage } of items) {
    const outcome = await draftForMessage(message, triage, deps);
    counts[outcome.kind] = (counts[outcome.kind] ?? 0) + 1;
    outcomes.push({ message, outcome });
  }

  return { outcomes, counts };
}
