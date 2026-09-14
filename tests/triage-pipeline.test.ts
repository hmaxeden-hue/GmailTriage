import { describe, expect, it } from 'vitest';
import { NoopDraftSink, NoopLabelSink } from '../src/adapters/gmail/draft.js';
import { FixtureMailSource } from '../src/adapters/gmail/fixture-source.js';
import { loadPromptTemplates } from '../src/adapters/prompts.js';
import { openDb } from '../src/adapters/sqlite/db.js';
import {
  SqliteDraftStore,
  SqliteNotificationStore,
  SqliteStore,
  SqliteTriageStore,
} from '../src/adapters/sqlite/repo.js';
import { NoopNotifier, createNotifier } from '../src/adapters/telegram/client.js';
import { AppConfig, ProfileConfig } from '../src/config/schema.js';
import { renderDigest } from '../src/core/digest.js';
import type { DraftSink } from '../src/core/ports.js';
import { runTriage, type TriageDeps } from '../src/pipeline/triage.js';
import { FakeLlmClient, answer } from './helpers/fake-llm.js';

const PROFILE = ProfileConfig.parse({
  betrieb: { name: 'Muster AG', gewerk: '«Gewerk»', ort: 'Luzern', email: 'b@example.ch' },
  vipAbsender: ['@vip-verwaltung.example'],
  ausschluss: { domains: ['lieferant.example'], betreffMuster: ['^Newsletter'] },
});

const APP = AppConfig.parse({ llm: { model: 'fake-model' } });
const AFTER = new Date('2020-01-01T00:00:00Z');

class SpyDraftSink implements DraftSink {
  readonly created: string[] = [];
  async findDraft(): Promise<string | null> {
    return null;
  }
  async createReplyDraft(input: { threadId: string }): Promise<{ draftId: string }> {
    this.created.push(input.threadId);
    return { draftId: `d-${this.created.length}` };
  }
}

function setup(over: Partial<TriageDeps> = {}) {
  const db = openDb(':memory:');
  // Zehn Antworten: zwei Mails werden vor dem Modell aussortiert.
  const llm = new FakeLlmClient(Array.from({ length: 10 }, () => answer()));
  const draftSink = new SpyDraftSink();
  const labelSink = new NoopLabelSink();
  const notifier = new NoopNotifier();

  const deps: TriageDeps = {
    source: new FixtureMailSource('fixtures'),
    llm,
    draftSink,
    labelSink,
    notifier,
    messages: new SqliteStore(db),
    triage: new SqliteTriageStore(db),
    drafts: new SqliteDraftStore(db),
    notifications: new SqliteNotificationStore(db),
    profile: PROFILE,
    app: APP,
    templates: loadPromptTemplates(),
    since: AFTER,
    max: 100,
    write: false,
    reclassify: false,
    now: () => 1_700_000_000_000,
    ...over,
  };

  return { db, deps, llm, draftSink, labelSink, notifier };
}

describe('runTriage — Gesamtlauf', () => {
  it('liest, ordnet ein und bereitet Entwürfe vor', async () => {
    const { db, deps } = setup();
    const summary = await runTriage(deps);

    expect(summary.ingest['gefunden']).toBe(12);
    expect(summary.classify['klassifiziert']).toBe(10);
    expect(summary.drafts['erstellt']).toBe(10);
    expect(summary.items).toHaveLength(10);
    db.close();
  });

  it('hängt den Entwurf an den Digest-Eintrag', async () => {
    const { db, deps } = setup();
    const summary = await runTriage(deps);
    expect(summary.items.every((i) => i.draft !== null)).toBe(true);
    db.close();
  });

  it('erzeugt einen Digest, der alle Einträge nennt', async () => {
    const { db, deps } = setup();
    const summary = await runTriage(deps);
    const digest = renderDigest(summary.items, {
      date: new Date('2026-09-14T18:00:00+02:00'),
      sonstige: summary.sonstige,
    });
    expect(digest).toContain('Martina Rüegg');
    expect(digest).toContain('Entwurf berechnet');
    db.close();
  });
});

describe('Dry-Run-Garantie über den ganzen Lauf', () => {
  it('legt weder Entwurf noch Label an und sendet keinen Push', async () => {
    const { db, deps, draftSink, labelSink, notifier } = setup({
      app: AppConfig.parse({ llm: { model: 'fake' }, gmail: { label: 'Triage/Anfrage' } }),
    });
    await runTriage(deps);

    expect(draftSink.created).toHaveLength(0);
    expect(labelSink.labelled).toHaveLength(0);
    expect(notifier.sent.length).toBeGreaterThan(0); // Noop merkt sich nur
    db.close();
  });

  it('markiert die abgelegten Entwürfe als Dry-Run', async () => {
    const { db, deps } = setup();
    const summary = await runTriage(deps);
    expect(summary.items.every((i) => i.draft?.dryRun === true)).toBe(true);
    db.close();
  });
});

describe('--write', () => {
  it('legt Entwürfe an und setzt das konfigurierte Label', async () => {
    const { db, deps, draftSink, labelSink } = setup({
      write: true,
      app: AppConfig.parse({ llm: { model: 'fake' }, gmail: { label: 'Triage/Anfrage' } }),
    });
    await runTriage(deps);

    expect(draftSink.created).toHaveLength(10);
    expect(labelSink.labelled).toHaveLength(10);
    db.close();
  });

  it('ein zweiter Lauf legt nichts doppelt an', async () => {
    const { db, deps, draftSink } = setup({ write: true });
    await runTriage(deps);
    const zweiterLlm = new FakeLlmClient([]);
    const second = await runTriage({ ...deps, llm: zweiterLlm });

    expect(draftSink.created).toHaveLength(10);
    expect(second.classify['uebersprungen']).toBe(10);
    expect(second.drafts['vorhanden']).toBe(10);
    expect(zweiterLlm.calls).toHaveLength(0);
    db.close();
  });
});

describe('Telegram-Push', () => {
  it('geht nur bei hoher Dringlichkeit hinaus', async () => {
    const { db, deps, notifier } = setup({
      llm: new FakeLlmClient([
        answer({ urgency: 'hoch' }),
        ...Array.from({ length: 9 }, () => answer({ urgency: 'normal' })),
      ]),
    });
    const summary = await runTriage(deps);

    // Die neueste Mail (fix-04) bekommt "hoch"; dazu heben die beiden
    // VIP-Mails ihre Dringlichkeit selbst an. Macht drei, nicht zehn.
    expect(summary.pushes).toBe(3);
    expect(notifier.sent).toHaveLength(3);
    expect(notifier.sent.every((t) => t.startsWith('Dringende Anfrage'))).toBe(true);

    const gemeldet = summary.items
      .filter((i) => i.triage.urgency === 'hoch')
      .map((i) => i.message.messageId)
      .sort();
    expect(gemeldet).toEqual(['fix-04', 'fix-08', 'fix-09']);
    db.close();
  });

  it('meldet dieselbe Mail kein zweites Mal', async () => {
    const { db, deps, notifier } = setup({
      llm: new FakeLlmClient(Array.from({ length: 10 }, () => answer({ urgency: 'hoch' }))),
    });
    const first = await runTriage(deps);
    const second = await runTriage({ ...deps, llm: new FakeLlmClient([]) });

    expect(first.pushes).toBe(10);
    expect(second.pushes).toBe(0);
    expect(notifier.sent).toHaveLength(10);
    db.close();
  });

  it('überträgt keinen Mailtext', async () => {
    const { db, deps, notifier } = setup({
      llm: new FakeLlmClient(Array.from({ length: 10 }, () => answer({ urgency: 'hoch' }))),
    });
    await runTriage(deps);
    expect(notifier.sent.join('\n')).not.toContain('Bahnhofstrasse');
    db.close();
  });
});

describe('createNotifier', () => {
  it('bleibt stumm, solange das Flag aus ist', () => {
    const { notifier, reason } = createNotifier({ enabled: false, chatId: '1', write: true });
    expect(notifier).toBeInstanceOf(NoopNotifier);
    expect(reason).toContain('telegram.enabled');
  });

  it('bleibt im Dry-Run stumm', () => {
    const { reason } = createNotifier({ enabled: true, chatId: '1', write: false });
    expect(reason).toBe('Dry-Run');
  });

  it('bleibt ohne chatId stumm, statt halb zu senden', () => {
    const before = process.env['TELEGRAM_BOT_TOKEN'];
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    const { notifier, reason } = createNotifier({ enabled: true, chatId: undefined, write: true });
    expect(notifier).toBeInstanceOf(NoopNotifier);
    expect(reason).toContain('chatId');
    if (before === undefined) delete process.env['TELEGRAM_BOT_TOKEN'];
    else process.env['TELEGRAM_BOT_TOKEN'] = before;
  });

  it('bleibt ohne Token stumm', () => {
    const before = process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TELEGRAM_BOT_TOKEN'];
    const { reason } = createNotifier({ enabled: true, chatId: '1', write: true });
    expect(reason).toContain('TELEGRAM_BOT_TOKEN');
    if (before !== undefined) process.env['TELEGRAM_BOT_TOKEN'] = before;
  });
});

describe('Abbruch', () => {
  it('reicht einen fatalen Fehler bis in die Zusammenfassung durch', async () => {
    const { db, deps, draftSink } = setup({ llm: new FakeLlmClient(['__FATAL__']), write: true });
    const summary = await runTriage(deps);

    expect(summary.abortedWith).toContain('Ungültiger Schlüssel');
    expect(draftSink.created).toHaveLength(0);
    db.close();
  });
});
