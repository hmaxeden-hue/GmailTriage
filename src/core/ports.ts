import type { MessageRef, NormalizedMessage, RawMessage, TriageRecord } from './types.js';

/**
 * Ports. core/ definiert sie, adapters/ implementiert sie.
 * Ein Wechsel auf IMAP oder Outlook tauscht die Implementierung, nicht core/.
 */

export interface MailSource {
  list(q: { query: string; after: Date; max: number }): Promise<MessageRef[]>;
  get(messageId: string): Promise<RawMessage>;
}

/**
 * Entwuerfe. Bewusst ohne send(): der Port bietet keinen Sendeweg an,
 * damit kein Aufrufer versehentlich einen findet.
 */
export interface DraftSink {
  findDraft(messageId: string): Promise<string | null>;
  createReplyDraft(input: {
    threadId: string;
    inReplyTo: string | null;
    to: string;
    subject: string;
    body: string;
  }): Promise<{ draftId: string }>;
}

export interface LabelSink {
  addLabel(messageId: string, label: string): Promise<void>;
}

export interface LlmClient {
  readonly provider: 'anthropic' | 'openai-compatible';
  readonly model: string;
  complete(req: {
    system: string;
    user: string;
    temperature: number;
    maxTokens: number;
  }): Promise<{ text: string; model: string; usage?: { input: number; output: number } }>;
}

export interface Notifier {
  notify(text: string): Promise<void>;
}

export interface MessageStore {
  upsertMessage(m: NormalizedMessage): void;
  hasMessage(messageId: string): boolean;
  getMessage(messageId: string): NormalizedMessage | null;
  listMessages(since: Date): NormalizedMessage[];
  countMessages(): number;
}

export interface RunStore {
  startRun(r: { startedAt: number; sinceArg: string; writeMode: boolean; model: string | null }): number;
  finishRun(id: number, r: { finishedAt: number; counts: Record<string, number>; exitCode: number }): void;
}

export interface TriageStore {
  insertTriage(t: TriageRecord): number;
  /** Juengster Datensatz zu einer Mail, oder null. Basis der Re-Run-Logik. */
  latestTriage(messageId: string): TriageRecord | null;
  listTriage(since: Date): TriageRecord[];
}
