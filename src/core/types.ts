/** Gemeinsame Typen. Rein — kennt weder Gmail noch SQLite noch einen LLM-Anbieter. */

/** Ein Gmail-MIME-Part, reduziert auf das, was die Normalisierung braucht. */
export interface MimePart {
  mimeType: string;
  /** base64url-kodierter Inhalt, wie ihn die Gmail-API liefert. */
  data?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  parts?: MimePart[];
}

/** Rohform einer Mail, wie sie ein MailSource-Adapter liefert. */
export interface RawMessage {
  messageId: string;
  threadId: string;
  labelIds: string[];
  /** internalDate der Gmail-API, epoch ms. */
  internalDate: number;
  payload: MimePart;
}

export interface MessageRef {
  messageId: string;
  threadId: string;
}

/** Ergebnis der Normalisierung — das, was in SQLite landet. */
export interface NormalizedMessage {
  messageId: string;
  threadId: string;
  /** Message-ID-Header, für spaeteres In-Reply-To in CP3. */
  rfc822Id: string | null;
  fromName: string | null;
  fromEmail: string;
  toEmail: string | null;
  subject: string | null;
  internalDate: number;
  /** Zitate und Signatur entfernt, auf maxBodyChars gekappt. */
  bodyText: string;
  /** Separat aufbewahrt: Signaturen tragen oft die Kontaktdaten. */
  signatureText: string | null;
  bodyHash: string;
  labelIds: string[];
  /** true, wenn bodyText gekappt wurde. */
  truncated: boolean;
  ingestedAt: number;
}

/** Ein Triage-Ergebnis, wie es in SQLite landet. */
export interface TriageRecord {
  messageId: string;
  classification: 'offertanfrage' | 'bestandskunde' | 'sonstiges';
  urgency: 'hoch' | 'normal' | 'niedrig';
  /** Woher die Dringlichkeit stammt — die VIP-Whitelist hebt sie an. */
  urgencySource: 'llm' | 'vip_override';
  senderName: string | null;
  contact: string | null;
  location: string | null;
  service: string | null;
  desiredDate: string | null;
  objectInfo: string | null;
  budgetHint: string | null;
  missingFields: string[];
  /** Immer needs_human_review. Die Freigabe macht der Mensch. */
  status: 'needs_human_review';
  confidence: number;
  reasoning: string | null;
  provider: string;
  model: string;
  promptVersion: string;
  repairUsed: boolean;
  createdAt: number;
}
