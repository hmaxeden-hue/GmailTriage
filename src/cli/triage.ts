import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAuthClient, scopesFor } from '../adapters/gmail/auth.js';
import { GmailMailSource } from '../adapters/gmail/client.js';
import {
  GmailDraftSink,
  GmailLabelSink,
  NoopDraftSink,
  NoopLabelSink,
} from '../adapters/gmail/draft.js';
import { FixtureMailSource } from '../adapters/gmail/fixture-source.js';
import { createLlmClient } from '../adapters/llm/index.js';
import { loadPromptTemplates } from '../adapters/prompts.js';
import { openDb } from '../adapters/sqlite/db.js';
import {
  SqliteDraftStore,
  SqliteNotificationStore,
  SqliteStore,
  SqliteTriageStore,
} from '../adapters/sqlite/repo.js';
import { createNotifier } from '../adapters/telegram/client.js';
import { loadAppConfig, loadProfile, parseSince } from '../config/load.js';
import { isPlaceholder } from '../config/schema.js';
import { digestFilename, renderDigest } from '../core/digest.js';
import type { DraftSink, LabelSink, MailSource } from '../core/ports.js';
import { runTriage } from '../pipeline/triage.js';
import { parseCommonArgs } from './args.js';

const HELP = `
pnpm run triage [Optionen]

  --since=7d        Zeitfenster (d/h/m), Default aus config/app.yaml
  --write           Entwürfe anlegen, Label setzen, Push senden
  --model=...       Modell überschreiben
  --max=N           Obergrenze an Mails
  --fixtures=DIR    Statt Gmail aus Fixtures lesen
  --reclassify      Bereits Eingeordnetes neu bewerten
  --db=PFAD         Abweichender SQLite-Pfad
  --help

Ohne --write entsteht bei Gmail nichts und es geht kein Push hinaus. Der
LLM-Call findet trotzdem statt — ohne ihn gäbe es nichts einzuordnen.

Exit-Codes: 0 alles durch · 1 einzelne Mails fehlgeschlagen ·
2 Konfiguration unvollständig · 3 Lauf abgebrochen.
`.trim();

const EXIT_OK = 0;
const EXIT_TEILFEHLER = 1;
const EXIT_KONFIG = 2;
const EXIT_ABBRUCH = 3;

async function main(argv: string[]): Promise<number> {
  const args = parseCommonArgs(argv);
  if (args.help) {
    console.log(HELP);
    return EXIT_OK;
  }

  const app = loadAppConfig();
  const profile = loadProfile();
  const sinceArg = args.since ?? app.ingest.defaultSince;
  const since = new Date(Date.now() - parseSince(sinceArg));
  const max = args.max ?? app.gmail.maxResults;

  if (args.write && isPlaceholder(profile.betrieb.email)) {
    console.error(
      `betrieb.email in config/profile.yaml ist noch ein Platzhalter (${profile.betrieb.email}).\n` +
        'Ohne Absenderadresse kann kein Entwurf entstehen.',
    );
    return EXIT_KONFIG;
  }

  const llm = createLlmClient(app.llm, args.model);
  const needsGmail = !args.fixtures;
  const auth =
    needsGmail || args.write
      ? await getAuthClient({
          credentialsPath: app.gmail.credentialsPath,
          tokenPath: app.gmail.tokenPath,
          scopes: scopesFor({ drafts: args.write, label: app.gmail.label !== null }),
        })
      : null;

  const source: MailSource = args.fixtures
    ? new FixtureMailSource(args.fixtures)
    : new GmailMailSource(auth!);

  const draftSink: DraftSink =
    args.write && auth ? new GmailDraftSink(auth, profile.betrieb.email) : new NoopDraftSink();
  const labelSink: LabelSink = args.write && auth ? new GmailLabelSink(auth) : new NoopLabelSink();

  const { notifier, reason: pushOff } = createNotifier({
    enabled: app.telegram.enabled,
    chatId: app.telegram.chatId,
    write: args.write,
  });

  announce({ write: args.write, provider: llm.provider, model: llm.model, sinceArg, pushOff });

  const db = openDb(args.db ?? app.storage.dbPath);
  const messages = new SqliteStore(db);
  const runId = messages.startRun({
    startedAt: Date.now(),
    sinceArg,
    writeMode: args.write,
    model: llm.model,
  });

  try {
    const summary = await runTriage({
      source,
      llm,
      draftSink,
      labelSink,
      notifier,
      messages,
      triage: new SqliteTriageStore(db),
      drafts: new SqliteDraftStore(db),
      notifications: new SqliteNotificationStore(db),
      profile,
      app,
      templates: loadPromptTemplates(),
      since,
      max,
      write: args.write,
      reclassify: args.reclassify,
      now: () => Date.now(),
    });

    const digest = renderDigest(summary.items, { date: new Date(), sonstige: summary.sonstige });
    console.log(digest);

    // Ein abgebrochener Lauf ohne Ergebnisse darf den Digest des Tages nicht
    // durch eine leere Datei ersetzen.
    if (summary.abortedWith && summary.items.length === 0) {
      console.log('Digest nicht geschrieben: der Lauf brach ab, bevor etwas vorlag.');
    } else {
      console.log(`Digest geschrieben: ${writeDigest(app.storage.outDir, digest)}`);
    }
    console.log(
      `Gelesen ${summary.ingest['gefunden'] ?? 0} · ` +
        `eingeordnet ${summary.classify['klassifiziert'] ?? 0} · ` +
        `Entwürfe ${summary.drafts['erstellt'] ?? 0} · ` +
        `Pushes ${summary.pushes}${args.write ? '' : ' (Dry-Run)'}`,
    );

    const counts = { ...summary.ingest, ...summary.classify, ...summary.drafts };
    messages.finishRun(runId, {
      finishedAt: Date.now(),
      counts,
      exitCode: exitCodeFor(summary),
    });

    if (summary.abortedWith) console.error(`\nLauf abgebrochen: ${summary.abortedWith}`);
    return exitCodeFor(summary);
  } finally {
    db.close();
  }
}

function exitCodeFor(summary: {
  abortedWith: string | null;
  classify: Record<string, number>;
  drafts: Record<string, number>;
}): number {
  if (summary.abortedWith) return EXIT_ABBRUCH;
  const failed = (summary.classify['fehlgeschlagen'] ?? 0) + (summary.drafts['fehlgeschlagen'] ?? 0);
  return failed > 0 ? EXIT_TEILFEHLER : EXIT_OK;
}

function announce(ctx: {
  write: boolean;
  provider: string;
  model: string;
  sinceArg: string;
  pushOff: string | null;
}): void {
  console.log(`Zeitraum: --since=${ctx.sinceArg} · Modell: ${ctx.model} (${ctx.provider})`);
  console.log(
    ctx.write
      ? 'Modus: --write — Entwürfe werden angelegt. Versendet wird nie etwas.'
      : 'Modus: Dry-Run — keine Entwürfe, keine Labels, keine Pushes.',
  );
  if (ctx.provider === 'anthropic') {
    console.log('Mailtexte gehen an api.anthropic.com (USA). Das gilt auch im Dry-Run.');
  }
  if (ctx.pushOff) console.log(`Telegram-Push aus: ${ctx.pushOff}.`);
  console.log('');
}

function writeDigest(outDir: string, digest: string): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, digestFilename(new Date()));
  writeFileSync(path, digest, 'utf8');
  return path;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`Fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_KONFIG);
  });
