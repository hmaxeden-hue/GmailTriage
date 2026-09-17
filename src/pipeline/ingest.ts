import type { ProfileConfig } from '../config/schema.js';
import { checkExclusion, isVip } from '../core/exclusion.js';
import { normalizeMessage } from '../core/normalize.js';
import type { MailSource, MessageStore } from '../core/ports.js';
import type { NormalizedMessage } from '../core/types.js';

export interface IngestRow {
  message: NormalizedMessage;
  excludedReason: string | null;
  vip: boolean;
}

export interface IngestResult {
  rows: IngestRow[];
  counts: { gefunden: number; ausgeschlossen: number; vip: number };
}

/**
 * Liest Mails, normalisiert sie und legt sie lokal ab.
 * Read-only nach aussen: dieser Ablauf kennt weder Draft- noch Label- noch
 * Benachrichtigungs-Ports.
 */
export async function runIngest(deps: {
  source: MailSource;
  store: MessageStore;
  profile: ProfileConfig;
  query: string;
  after: Date;
  max: number;
  maxBodyChars: number;
  now: () => number;
}): Promise<IngestResult> {
  const refs = await deps.source.list({ query: deps.query, after: deps.after, max: deps.max });
  const rows: IngestRow[] = [];

  for (const ref of refs) {
    const raw = await deps.source.get(ref.messageId);
    const message = normalizeMessage(raw, {
      maxBodyChars: deps.maxBodyChars,
      now: deps.now(),
    });
    deps.store.upsertMessage(message);
    rows.push({
      message,
      excludedReason: checkExclusion(message, deps.profile).reason,
      vip: isVip(message, deps.profile),
    });
  }

  return {
    rows,
    counts: {
      gefunden: rows.length,
      ausgeschlossen: rows.filter((r) => r.excludedReason !== null).length,
      vip: rows.filter((r) => r.vip).length,
    },
  };
}
