import { createLlmClient } from '../adapters/llm/index.js';
import { loadPromptTemplates } from '../adapters/prompts.js';
import { openDb } from '../adapters/sqlite/db.js';
import { SqliteStore, SqliteTriageStore } from '../adapters/sqlite/repo.js';
import { loadAppConfig, loadProfile, parseSince } from '../config/load.js';
import { runClassify, type ClassifyOutcome } from '../pipeline/classify.js';
import type { NormalizedMessage } from '../core/types.js';
import { parseCommonArgs } from './args.js';

const HELP = `
pnpm classify [Optionen]

  --since=7d       Zeitfenster über die bereits eingelesenen Mails
  --model=...      Modell überschreiben (sonst llm.model aus config/app.yaml)
  --reclassify     Bereits klassifizierte Mails erneut einordnen
  --db=PFAD        Abweichender SQLite-Pfad
  --help

Klassifiziert, was pnpm ingest abgelegt hat. Es entstehen keine Entwürfe und
keine Nachrichten — das ist CP3. Mit provider: anthropic werden Mailinhalte an
einen externen Endpunkt übertragen; siehe README.
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

  const db = openDb(args.db ?? app.storage.dbPath);
  const messages = new SqliteStore(db).listMessages(since);
  const triage = new SqliteTriageStore(db);
  const llm = createLlmClient(app.llm, args.model);

  if (llm.provider === 'anthropic') {
    console.log(
      `Achtung: bis zu ${messages.length} Mailtexte gehen an api.anthropic.com (USA).\n` +
        'Das gilt auch ohne --write. Für rein lokalen Betrieb: llm.provider auf ' +
        'openai-compatible umstellen.\n',
    );
  }

  const runId = triageRun(db, args.since ?? app.ingest.defaultSince, llm.model);

  try {
    const result = await runClassify(messages, {
      llm,
      store: triage,
      profile,
      templates: loadPromptTemplates(),
      temperature: app.llm.temperature,
      maxTokens: app.llm.maxTokens,
      skipAlreadyClassified: !args.reclassify,
      now: () => Date.now(),
    });

    for (const { message, outcome } of result.outcomes) print(message, outcome);
    console.log('');
    if (result.abortedWith) {
      console.error(`Lauf abgebrochen: ${result.abortedWith}`);
    }
    console.log(
      Object.entries(result.counts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', '),
    );

    new SqliteStore(db).finishRun(runId, {
      finishedAt: Date.now(),
      counts: result.counts,
      exitCode: 0,
    });
    return result.abortedWith || result.counts['fehlgeschlagen'] ? 1 : 0;
  } finally {
    db.close();
  }
}

function triageRun(db: ReturnType<typeof openDb>, sinceArg: string, model: string): number {
  return new SqliteStore(db).startRun({
    startedAt: Date.now(),
    sinceArg,
    writeMode: false,
    model,
  });
}

function print(m: NormalizedMessage, outcome: ClassifyOutcome): void {
  const who = (m.fromName ?? m.fromEmail).slice(0, 24).padEnd(25);
  if (outcome.kind === 'ausgeschlossen') {
    console.log(`${who} ausgeschlossen (${outcome.reason})`);
    return;
  }
  const r = outcome.record;
  const vip = r.urgencySource === 'vip_override' ? ' (VIP)' : '';
  const missing = r.missingFields.length ? ` fehlt: ${r.missingFields.join(', ')}` : '';
  const mark = outcome.kind === 'uebersprungen' ? '·' : outcome.kind === 'fehlgeschlagen' ? '!' : ' ';
  console.log(
    `${mark} ${who}${r.classification.padEnd(15)}${(r.urgency + vip).padEnd(14)}` +
      `${r.confidence.toFixed(2)}${missing}`,
  );
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`Fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
