import { describe, expect, it } from 'vitest';
import { FixtureMailSource } from '../src/adapters/gmail/fixture-source.js';
import { NoopDraftSink, NoopLabelSink } from '../src/adapters/gmail/draft.js';
import { openDb } from '../src/adapters/sqlite/db.js';
import { SqliteDraftStore, SqliteStore, SqliteTriageStore } from '../src/adapters/sqlite/repo.js';
import { ProfileConfig } from '../src/config/schema.js';
import type { DraftSink } from '../src/core/ports.js';
import type { NormalizedMessage, TriageRecord } from '../src/core/types.js';
import { draftForMessage, runDrafts, type DraftDeps } from '../src/pipeline/draft.js';
import { runIngest } from '../src/pipeline/ingest.js';

const PROFILE = ProfileConfig.parse({
  betrieb: { name: 'Muster AG', gewerk: '«Gewerk»', ort: 'Luzern', email: 'b@example.ch' },
  vipAbsender: ['@vip-verwaltung.example'],
  ausschluss: { domains: ['lieferant.example'], betreffMuster: ['^Newsletter'] },
});

const AFTER = new Date('2020-01-01T00:00:00Z');

/** Zählt die Aufrufe und merkt sich, was an Gmail ginge. */
class SpyDraftSink implements DraftSink {
  readonly created: Array<{ threadId: string; inReplyTo: string | null; to: string; body: string }> = [];
  constructor(private readonly fail = false) {}

  async findDraft(): Promise<string | null> {
    return null;
  }

  async createReplyDraft(input: {
    threadId: string; inReplyTo: string | null; to: string; subject: string; body: string;
  }): Promise<{ draftId: string }> {
    if (this.fail) throw new Error('Gmail antwortete 500');
    this.created.push(input);
    return { draftId: `draft-${this.created.length}` };
  }
}

async function setup() {
  const db = openDb(':memory:');
  const store = new SqliteStore(db);
  await runIngest({
    source: new FixtureMailSource('fixtures'),
    store,
    profile: PROFILE,
    query: 'is:unread',
    after: AFTER,
    max: 100,
    maxBodyChars: 8000,
    now: () => 1_700_000_000_000,
  });
  return { db, store, triage: new SqliteTriageStore(db), drafts: new SqliteDraftStore(db) };
}

function triageFor(messageId: string, over: Partial<TriageRecord> = {}): TriageRecord {
  return {
    messageId, classification: 'offertanfrage', urgency: 'normal', urgencySource: 'llm',
    senderName: null, contact: null, location: null, service: null,
    desiredDate: null, objectInfo: null, budgetHint: null,
    missingFields: ['ort'], status: 'needs_human_review',
    confidence: 0.8, reasoning: null, provider: 'anthropic', model: 'm',
    promptVersion: 'v1', repairUsed: false, createdAt: 0, ...over,
  };
}

function deps(sink: DraftSink, drafts: SqliteDraftStore, over: Partial<DraftDeps> = {}): DraftDeps {
  return {
    sink,
    store: drafts,
    profile: PROFILE,
    from: 'b@example.ch',
    write: false,
    label: null,
    labelSink: new NoopLabelSink(),
    now: () => 1_700_000_000_000,
    ...over,
  };
}

function message(store: SqliteStore, id: string): NormalizedMessage {
  const m = store.getMessage(id);
  if (!m) throw new Error(`${id} fehlt`);
  return m;
}

describe('Dry-Run', () => {
  it('legt bei Gmail nichts an', async () => {
    const { db, store, drafts } = await setup();
    const sink = new SpyDraftSink();
    const out = await draftForMessage(message(store, 'fix-01'), triageFor('fix-01'), deps(sink, drafts));

    expect(out.kind).toBe('erstellt');
    expect(sink.created).toHaveLength(0);
    db.close();
  });

  it('hält den berechneten Text trotzdem fest', async () => {
    const { db, store, drafts } = await setup();
    await draftForMessage(message(store, 'fix-01'), triageFor('fix-01'), deps(new SpyDraftSink(), drafts));

    const saved = drafts.getDraft('fix-01');
    expect(saved?.dryRun).toBe(true);
    expect(saved?.gmailDraftId).toBeNull();
    expect(saved?.kind).toBe('rueckfrage');
    db.close();
  });

  it('setzt kein Label', async () => {
    const { db, store, drafts } = await setup();
    const labelSink = new NoopLabelSink();
    await draftForMessage(
      message(store, 'fix-01'),
      triageFor('fix-01'),
      deps(new SpyDraftSink(), drafts, { label: 'Triage/Offertanfrage', labelSink }),
    );
    expect(labelSink.labelled).toHaveLength(0);
    db.close();
  });
});

describe('--write', () => {
  it('legt genau einen Entwurf an und merkt sich die Gmail-ID', async () => {
    const { db, store, drafts } = await setup();
    const sink = new SpyDraftSink();
    await draftForMessage(
      message(store, 'fix-01'),
      triageFor('fix-01'),
      deps(sink, drafts, { write: true }),
    );

    expect(sink.created).toHaveLength(1);
    expect(drafts.getDraft('fix-01')?.gmailDraftId).toBe('draft-1');
    expect(drafts.getDraft('fix-01')?.dryRun).toBe(false);
    db.close();
  });

  it('antwortet im Thread und an den Absender', async () => {
    const { db, store, drafts } = await setup();
    const sink = new SpyDraftSink();
    await draftForMessage(
      message(store, 'fix-01'),
      triageFor('fix-01'),
      deps(sink, drafts, { write: true }),
    );

    expect(sink.created[0]?.threadId).toBe('fix-01');
    expect(sink.created[0]?.inReplyTo).toBe('<fix-01@mail.example.com>');
    expect(sink.created[0]?.to).toBe('m.rueegg@example.ch');
    db.close();
  });

  it('setzt das Label, wenn eines konfiguriert ist', async () => {
    const { db, store, drafts } = await setup();
    const labelSink = new NoopLabelSink();
    await draftForMessage(
      message(store, 'fix-01'),
      triageFor('fix-01'),
      deps(new SpyDraftSink(), drafts, { write: true, label: 'Triage/Anfrage', labelSink }),
    );
    expect(labelSink.labelled).toEqual([{ messageId: 'fix-01', label: 'Triage/Anfrage' }]);
    db.close();
  });

  it('meldet einen Gmail-Fehler, ohne den Lauf abzubrechen', async () => {
    const { db, store, drafts } = await setup();
    const out = await draftForMessage(
      message(store, 'fix-01'),
      triageFor('fix-01'),
      deps(new SpyDraftSink(true), drafts, { write: true }),
    );

    expect(out.kind).toBe('fehlgeschlagen');
    expect(drafts.getDraft('fix-01')).toBeNull();
    db.close();
  });
});

describe('Idempotenz', () => {
  it('ein zweiter Lauf erzeugt keinen zweiten Entwurf', async () => {
    const { db, store, drafts } = await setup();
    const sink = new SpyDraftSink();
    const m = message(store, 'fix-01');

    await draftForMessage(m, triageFor('fix-01'), deps(sink, drafts, { write: true }));
    const second = await draftForMessage(m, triageFor('fix-01'), deps(sink, drafts, { write: true }));

    expect(second.kind).toBe('vorhanden');
    expect(sink.created).toHaveLength(1);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    expect(rows.n).toBe(1);
    db.close();
  });

  it('auch dreimal hintereinander bleibt es bei einem', async () => {
    const { db, store, drafts } = await setup();
    const sink = new SpyDraftSink();
    const m = message(store, 'fix-01');
    for (let i = 0; i < 3; i++) {
      await draftForMessage(m, triageFor('fix-01'), deps(sink, drafts, { write: true }));
    }
    expect(sink.created).toHaveLength(1);
    db.close();
  });

  it('zieht einen Dry-Run-Eintrag beim späteren --write nach', async () => {
    const { db, store, drafts } = await setup();
    const sink = new SpyDraftSink();
    const m = message(store, 'fix-01');

    await draftForMessage(m, triageFor('fix-01'), deps(sink, drafts));
    expect(drafts.getDraft('fix-01')?.dryRun).toBe(true);

    await draftForMessage(m, triageFor('fix-01'), deps(sink, drafts, { write: true }));
    const saved = drafts.getDraft('fix-01');
    expect(saved?.dryRun).toBe(false);
    expect(saved?.gmailDraftId).toBe('draft-1');

    const rows = db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    expect(rows.n).toBe(1);
    db.close();
  });

  it('ein Dry-Run nach einem echten Entwurf überschreibt nichts', async () => {
    const { db, store, drafts } = await setup();
    const sink = new SpyDraftSink();
    const m = message(store, 'fix-01');

    await draftForMessage(m, triageFor('fix-01'), deps(sink, drafts, { write: true }));
    await draftForMessage(m, triageFor('fix-01'), deps(sink, drafts));

    expect(drafts.getDraft('fix-01')?.gmailDraftId).toBe('draft-1');
    expect(sink.created).toHaveLength(1);
    db.close();
  });
});

describe('runDrafts über alle Fixtures', () => {
  it('überspringt sonstiges und zählt die Ausgänge', async () => {
    const { db, store, drafts } = await setup();
    const messages = store.listMessages(AFTER);
    const items = messages.map((m) => ({
      message: m,
      triage: triageFor(
        m.messageId,
        ['fix-10', 'fix-11', 'fix-12'].includes(m.messageId)
          ? { classification: 'sonstiges' as const }
          : {},
      ),
    }));

    const sink = new SpyDraftSink();
    const result = await runDrafts(items, deps(sink, drafts, { write: true }));

    expect(result.counts).toEqual({
      erstellt: 9,
      vorhanden: 0,
      nicht_noetig: 3,
      fehlgeschlagen: 0,
    });
    expect(sink.created).toHaveLength(9);
    db.close();
  });

  it('ein zweiter Durchlauf ruft Gmail nicht mehr an', async () => {
    const { db, store, drafts } = await setup();
    const items = store.listMessages(AFTER).map((m) => ({ message: m, triage: triageFor(m.messageId) }));
    const sink = new SpyDraftSink();

    await runDrafts(items, deps(sink, drafts, { write: true }));
    const second = await runDrafts(items, deps(sink, drafts, { write: true }));

    expect(second.counts['vorhanden']).toBe(12);
    expect(sink.created).toHaveLength(12);
    db.close();
  });
});

describe('NoopDraftSink', () => {
  it('merkt sich, was passiert wäre', async () => {
    const sink = new NoopDraftSink();
    await sink.createReplyDraft({
      threadId: 't1', inReplyTo: null, to: 'x@example.ch', subject: 'Re: Test', body: 'x',
    });
    expect(sink.created).toEqual([{ threadId: 't1', subject: 'Re: Test' }]);
  });
});
