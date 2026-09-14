import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MailSource } from '../../core/ports.js';
import type { MessageRef, RawMessage } from '../../core/types.js';
import { toRawMessage } from './client.js';

/**
 * Liest Fixtures statt Gmail. Damit laufen Ingest und Tests ohne OAuth,
 * ohne Netzwerk und ohne echte Mail-Inhalte.
 */
export class FixtureMailSource implements MailSource {
  private readonly byId = new Map<string, RawMessage>();

  constructor(dir: string) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const raw = toRawMessage(JSON.parse(readFileSync(join(dir, file), 'utf8')));
      this.byId.set(raw.messageId, raw);
    }
  }

  async list(q: { query: string; after: Date; max: number }): Promise<MessageRef[]> {
    return [...this.byId.values()]
      .filter((m) => m.internalDate >= q.after.getTime())
      .sort((a, b) => b.internalDate - a.internalDate)
      .slice(0, q.max)
      .map((m) => ({ messageId: m.messageId, threadId: m.threadId }));
  }

  async get(messageId: string): Promise<RawMessage> {
    const hit = this.byId.get(messageId);
    if (!hit) throw new Error(`Fixture ${messageId} nicht gefunden`);
    return hit;
  }
}
