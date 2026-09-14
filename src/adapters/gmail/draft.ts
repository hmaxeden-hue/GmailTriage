import { gmail, type gmail_v1 } from '@googleapis/gmail';
import type { OAuth2Client } from 'google-auth-library';
import { buildRfc822, toBase64Url } from '../../core/mime.js';
import type { DraftSink, LabelSink } from '../../core/ports.js';

/**
 * Legt Antwortentwuerfe an — und nur das.
 *
 * Regel 1: Der einzige Gmail-Aufruf hier ist users.drafts.create. Die
 * Endpunkte, die eine Mail hinausgeben wuerden, kommen im Projekt nirgends
 * vor; tests/no-send.test.ts sucht im ganzen Quelltext danach und schlaegt
 * fehl, sobald einer auftaucht — auch in einem Kommentar wie diesem.
 */
export class GmailDraftSink implements DraftSink {
  private readonly api: gmail_v1.Gmail;

  constructor(
    auth: OAuth2Client,
    private readonly from: string,
  ) {
    this.api = gmail({ version: 'v1', auth });
  }

  /**
   * Die Idempotenz liegt in SQLite, nicht hier: Gmail kennt keine Zuordnung
   * von Entwurf zu Ursprungsnachricht, nach der sich zuverlaessig suchen liesse.
   */
  async findDraft(): Promise<string | null> {
    return null;
  }

  async createReplyDraft(input: {
    threadId: string;
    inReplyTo: string | null;
    to: string;
    subject: string;
    body: string;
  }): Promise<{ draftId: string }> {
    const raw = toBase64Url(
      buildRfc822({
        from: this.from,
        to: input.to,
        subject: input.subject,
        inReplyTo: input.inReplyTo,
        body: input.body,
      }),
    );

    const res = await this.api.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw, threadId: input.threadId } },
    });

    const draftId = res.data.id;
    if (!draftId) throw new Error('Gmail hat keinen Entwurf zurückgegeben.');
    return { draftId };
  }
}

export class GmailLabelSink implements LabelSink {
  private readonly api: gmail_v1.Gmail;
  private cache = new Map<string, string>();

  constructor(auth: OAuth2Client) {
    this.api = gmail({ version: 'v1', auth });
  }

  async addLabel(messageId: string, label: string): Promise<void> {
    const labelId = await this.ensureLabel(label);
    await this.api.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds: [labelId] },
    });
  }

  private async ensureLabel(name: string): Promise<string> {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const list = await this.api.users.labels.list({ userId: 'me' });
    const hit = list.data.labels?.find((l) => l.name === name);
    if (hit?.id) {
      this.cache.set(name, hit.id);
      return hit.id;
    }

    const created = await this.api.users.labels.create({
      userId: 'me',
      requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
    if (!created.data.id) throw new Error(`Label ${name} konnte nicht angelegt werden.`);
    this.cache.set(name, created.data.id);
    return created.data.id;
  }
}

/** Dry-Run: protokolliert, wirkt nicht. */
export class NoopDraftSink implements DraftSink {
  readonly created: Array<{ threadId: string; subject: string }> = [];

  async findDraft(): Promise<string | null> {
    return null;
  }

  async createReplyDraft(input: {
    threadId: string;
    inReplyTo: string | null;
    to: string;
    subject: string;
    body: string;
  }): Promise<{ draftId: string }> {
    this.created.push({ threadId: input.threadId, subject: input.subject });
    return { draftId: '' };
  }
}

export class NoopLabelSink implements LabelSink {
  readonly labelled: Array<{ messageId: string; label: string }> = [];

  async addLabel(messageId: string, label: string): Promise<void> {
    this.labelled.push({ messageId, label });
  }
}
