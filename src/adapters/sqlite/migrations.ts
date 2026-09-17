/** Nummerierte Migrationen. Der Index in diesem Array ist die Zielversion. */
export const MIGRATIONS: string[] = [
  // 1 — Rohschicht, Triage, Entwuerfe, Benachrichtigungen, Laeufe.
  `
  CREATE TABLE messages (
    message_id     TEXT PRIMARY KEY,
    thread_id      TEXT NOT NULL,
    rfc822_id      TEXT,
    from_name      TEXT,
    from_email     TEXT NOT NULL,
    to_email       TEXT,
    subject        TEXT,
    internal_date  INTEGER NOT NULL,
    body_text      TEXT NOT NULL,
    signature_text TEXT,
    body_hash      TEXT NOT NULL,
    labels_json    TEXT NOT NULL,
    truncated      INTEGER NOT NULL DEFAULT 0,
    ingested_at    INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_date ON messages(internal_date DESC);

  CREATE TABLE triage_results (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id     TEXT NOT NULL REFERENCES messages(message_id),
    classification TEXT NOT NULL CHECK (classification IN ('offertanfrage','bestandskunde','sonstiges')),
    urgency        TEXT NOT NULL CHECK (urgency IN ('hoch','normal','niedrig')),
    urgency_source TEXT NOT NULL CHECK (urgency_source IN ('llm','vip_override')),
    sender_name    TEXT,
    contact        TEXT,
    location       TEXT,
    service        TEXT,
    desired_date   TEXT,
    object_info    TEXT,
    budget_hint    TEXT,
    missing_fields_json TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'needs_human_review'
                   CHECK (status = 'needs_human_review'),
    confidence     REAL NOT NULL,
    reasoning      TEXT,
    provider       TEXT NOT NULL,
    model          TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    repair_used    INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX idx_triage_msg ON triage_results(message_id, created_at DESC);

  CREATE TABLE drafts (
    message_id     TEXT PRIMARY KEY REFERENCES messages(message_id),
    thread_id      TEXT NOT NULL,
    gmail_draft_id TEXT,
    kind           TEXT NOT NULL CHECK (kind IN ('rueckfrage','eingangsbestaetigung')),
    body           TEXT NOT NULL,
    dry_run        INTEGER NOT NULL,
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE notifications (
    message_id TEXT NOT NULL,
    channel    TEXT NOT NULL,
    sent_at    INTEGER NOT NULL,
    dry_run    INTEGER NOT NULL,
    PRIMARY KEY (message_id, channel)
  );

  CREATE TABLE runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    since_arg   TEXT,
    write_mode  INTEGER NOT NULL,
    model       TEXT,
    counts_json TEXT,
    exit_code   INTEGER
  );
  `,
];
