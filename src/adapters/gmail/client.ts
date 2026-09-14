import { gmail, type gmail_v1 } from '@googleapis/gmail';
import type { OAuth2Client } from 'google-auth-library';
import type { MailSource } from '../../core/ports.js';
import type { MessageRef, MimePart, RawMessage } from '../../core/types.js';

/**
 * Read-only Zugriff auf Gmail.
 * Die Klasse bietet bewusst keine Methode zum Versand an — der einzige
 * Schreibweg des Projekts entsteht spaeter in CP3 als Draft-Adapter.
 */
export class GmailMailSource implements MailSource {
  private readonly api: gmail_v1.Gmail;

  constructor(auth: OAuth2Client) {
    this.api = gmail({ version: 'v1', auth });
  }

  async list(q: { query: string; after: Date; max: number }): Promise<MessageRef[]> {
    const query = `${q.query} after:${Math.floor(q.after.getTime() / 1000)}`;
    const refs: MessageRef[] = [];
    let pageToken: string | undefined;

    do {
      const res = await this.api.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: Math.min(100, q.max - refs.length),
        ...(pageToken ? { pageToken } : {}),
      });
      for (const m of res.data.messages ?? []) {
        if (m.id && m.threadId) refs.push({ messageId: m.id, threadId: m.threadId });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken && refs.length < q.max);

    return refs.slice(0, q.max);
  }

  async get(messageId: string): Promise<RawMessage> {
    const res = await this.api.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    return toRawMessage(res.data);
  }
}

export function toRawMessage(m: gmail_v1.Schema$Message): RawMessage {
  if (!m.id || !m.threadId) throw new Error('Gmail-Nachricht ohne id/threadId');
  return {
    messageId: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds ?? [],
    internalDate: Number(m.internalDate ?? 0),
    payload: toMimePart(m.payload ?? {}),
  };
}

function toMimePart(p: gmail_v1.Schema$MessagePart): MimePart {
  const part: MimePart = { mimeType: p.mimeType ?? 'text/plain' };
  if (p.body?.data) part.data = p.body.data;
  if (p.filename) part.filename = p.filename;
  if (p.headers?.length) {
    part.headers = p.headers
      .filter((h): h is { name: string; value: string } => Boolean(h.name && h.value))
      .map((h) => ({ name: h.name, value: h.value }));
  }
  if (p.parts?.length) part.parts = p.parts.map(toMimePart);
  return part;
}
