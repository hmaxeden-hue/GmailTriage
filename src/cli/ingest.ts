import { getAuthClient } from '../adapters/gmail/auth.js';
import { GmailMailSource } from '../adapters/gmail/client.js';
import { FixtureMailSource } from '../adapters/gmail/fixture-source.js';
import { openDb } from '../adapters/sqlite/db.js';
import { SqliteStore } from '../adapters/sqlite/repo.js';
import { loadAppConfig, loadProfile, parseSince } from '../config/load.js';
import type { MailSource } from '../core/ports.js';
import { runIngest, type IngestRow } from '../pipeline/ingest.js';
import { parseCommonArgs } from './args.js';

const HELP = `
pnpm ingest [Optionen]

  --since=7d        Zeitfenster (d/h/m), Default aus config/app.yaml
  --max=N           Obergrenze an Mails
  --fixtures=DIR    Statt Gmail aus Fixtures lesen (kein OAuth, kein Netzwerk)
  --db=PFAD         Abweichender SQLite-Pfad
  --write           Ohne Wirkung in CP1: Ingest ist read-only
  --help

Ingest liest ausschliesslich. Es entstehen keine Entwürfe, keine Labels und
keine Nachrichten — nur SQLite-Zeilen und diese Ausgabe.
`.trim();

async function main(argv: string[]): Promise<number> {
  const args = parseCommonArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const app = loadAppConfig();
  const profile = loadProfile();
  const sinceArg = args.since ?? app.ingest.defaultSince;
  const after = new Date(Date.now() - parseSince(sinceArg));
  const max = args.max ?? app.gmail.maxResults;

  if (args.write) {
    console.log('Hinweis: --write hat in CP1 keine Wirkung. Ingest schreibt nur nach SQLite.\n');
  }

  const source: MailSource = args.fixtures
    ? new FixtureMailSource(args.fixtures)
    : new GmailMailSource(
        await getAuthClient({
          credentialsPath: app.gmail.credentialsPath,
          tokenPath: app.gmail.tokenPath,
        }),
      );

  const db = openDb(args.db ?? app.storage.dbPath);
  const store = new SqliteStore(db);
  const runId = store.startRun({ startedAt: Date.now(), sinceArg, writeMode: false, model: null });

  try {
    const result = await runIngest({
      source,
      store,
      profile,
      query: app.gmail.query,
      after,
      max,
      maxBodyChars: app.ingest.maxBodyChars,
      now: () => Date.now(),
    });

    print(result.rows, {
      query: app.gmail.query,
      sinceArg,
      after,
      source: args.fixtures ?? 'gmail',
    });
    store.finishRun(runId, { finishedAt: Date.now(), counts: result.counts, exitCode: 0 });
    return 0;
  } finally {
    db.close();
  }
}

function print(
  rows: IngestRow[],
  ctx: { query: string; sinceArg: string; after: Date; source: string },
): void {
  const fmt = new Intl.DateTimeFormat('de-CH', { dateStyle: 'short', timeStyle: 'short' });
  console.log(`Quelle:   ${ctx.source}`);
  console.log(`Filter:   ${ctx.query}`);
  console.log(`Zeitraum: seit ${fmt.format(ctx.after)} (--since=${ctx.sinceArg})`);
  console.log('');

  for (const { message: m, excludedReason, vip } of rows) {
    const marks = [vip ? 'VIP' : null, excludedReason ? `ausgeschlossen: ${excludedReason}` : null]
      .filter(Boolean)
      .join(', ');
    console.log(
      `${fmt.format(new Date(m.internalDate)).padEnd(17)}` +
        `${(m.fromName ?? m.fromEmail).slice(0, 26).padEnd(28)}` +
        `${(m.subject ?? '(kein Betreff)').slice(0, 44).padEnd(46)}` +
        `${String(m.bodyText.length).padStart(5)} Z.` +
        (marks ? `  [${marks}]` : ''),
    );
  }

  const excluded = rows.filter((r) => r.excludedReason !== null).length;
  console.log('');
  console.log(
    `${rows.length} Mails gelesen, ${rows.length - excluded} für Triage vorgesehen, ` +
      `${excluded} ausgeschlossen.`,
  );
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`Fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
