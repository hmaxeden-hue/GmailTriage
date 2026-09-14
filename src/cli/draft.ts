import { getAuthClient, scopesFor } from '../adapters/gmail/auth.js';
import {
  GmailDraftSink,
  GmailLabelSink,
  NoopDraftSink,
  NoopLabelSink,
} from '../adapters/gmail/draft.js';
import { openDb } from '../adapters/sqlite/db.js';
import { SqliteDraftStore, SqliteStore, SqliteTriageStore } from '../adapters/sqlite/repo.js';
import { loadAppConfig, loadProfile, parseSince } from '../config/load.js';
import { isPlaceholder } from '../config/schema.js';
import type { DraftSink, LabelSink } from '../core/ports.js';
import type { NormalizedMessage, TriageRecord } from '../core/types.js';
import { runDrafts, type DraftOutcome } from '../pipeline/draft.js';
import { parseCommonArgs } from './args.js';

const HELP = `
pnpm draft [Optionen]

  --since=7d       Zeitfenster über die klassifizierten Mails
  --write          Entwürfe wirklich bei Gmail anlegen (sonst nur berechnen)
  --db=PFAD        Abweichender SQLite-Pfad
  --help

Ohne --write entsteht bei Gmail nichts: der Text wird berechnet, in SQLite
abgelegt und hier ausgegeben. Es wird nie eine Mail versendet — Entwürfe
bleiben liegen, bis du sie selbst abschickst.
`.trim();

async function main(argv: string[]): Promise<number> {
  const args = parseCommonArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const app = loadAppConfig();
  const profile = loadProfile();
  const since = new Date(Date.now() - parseSince(args.since ?? app.ingest.defaultSince));

  if (isPlaceholder(profile.betrieb.email)) {
    console.error(
      `betrieb.email in config/profile.yaml ist noch ein Platzhalter (${profile.betrieb.email}).\n` +
        'Ohne Absenderadresse entsteht kein Entwurf.',
    );
    return 2;
  }

  const db = openDb(args.db ?? app.storage.dbPath);
  const messages = new SqliteStore(db).listMessages(since);
  const triageStore = new SqliteTriageStore(db);

  const items: Array<{ message: NormalizedMessage; triage: TriageRecord }> = [];
  for (const message of messages) {
    const triage = triageStore.latestTriage(message.messageId);
    if (triage) items.push({ message, triage });
  }

  let sink: DraftSink = new NoopDraftSink();
  let labelSink: LabelSink = new NoopLabelSink();

  if (args.write) {
    const auth = await getAuthClient({
      credentialsPath: app.gmail.credentialsPath,
      tokenPath: app.gmail.tokenPath,
      scopes: scopesFor({ drafts: true, label: app.gmail.label !== null }),
    });
    sink = new GmailDraftSink(auth, profile.betrieb.email);
    labelSink = new GmailLabelSink(auth);
  } else {
    console.log('Dry-Run: es wird nichts bei Gmail angelegt. Mit --write wirklich schreiben.\n');
  }

  try {
    const result = await runDrafts(items, {
      sink,
      store: new SqliteDraftStore(db),
      profile,
      from: profile.betrieb.email,
      write: args.write,
      label: app.gmail.label,
      labelSink,
      now: () => Date.now(),
    });

    for (const { message, outcome } of result.outcomes) print(message, outcome, args.write);
    console.log('');
    console.log(
      Object.entries(result.counts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', '),
    );
    return result.counts['fehlgeschlagen'] ? 1 : 0;
  } finally {
    db.close();
  }
}

function print(m: NormalizedMessage, outcome: DraftOutcome, write: boolean): void {
  const who = (m.fromName ?? m.fromEmail).slice(0, 24).padEnd(25);
  switch (outcome.kind) {
    case 'nicht_noetig':
      return;
    case 'vorhanden':
      console.log(`· ${who}Entwurf liegt bereits vor`);
      return;
    case 'fehlgeschlagen':
      console.log(`! ${who}${outcome.error}`);
      return;
    case 'erstellt':
      console.log(`  ${who}${outcome.draft.kind}${write ? '' : ' (Dry-Run)'}`);
      console.log(
        outcome.text.body
          .split('\n')
          .map((l) => `      ${l}`)
          .join('\n'),
      );
      console.log('');
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`Fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
