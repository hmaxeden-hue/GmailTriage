import { describe, expect, it } from 'vitest';
import { FixtureMailSource } from '../src/adapters/gmail/fixture-source.js';
import { loadPromptTemplates } from '../src/adapters/prompts.js';
import { openDb } from '../src/adapters/sqlite/db.js';
import { SqliteStore, SqliteTriageStore } from '../src/adapters/sqlite/repo.js';
import { ProfileConfig } from '../src/config/schema.js';
import { normalizeMessage } from '../src/core/normalize.js';
import type { NormalizedMessage } from '../src/core/types.js';
import { classifyMessage, runClassify, type ClassifyDeps } from '../src/pipeline/classify.js';
import { runIngest } from '../src/pipeline/ingest.js';
import { FakeLlmClient, answer } from './helpers/fake-llm.js';

const PROFILE = ProfileConfig.parse({
  betrieb: { name: 'Testbetrieb', gewerk: '«Gewerk»', ort: 'Luzern', email: 'betrieb@example.ch' },
  vipAbsender: ['@vip-verwaltung.example'],
  ausschluss: { domains: ['lieferant.example'], betreffMuster: ['^Newsletter'] },
});

const TEMPLATES = loadPromptTemplates();
const AFTER = new Date('2020-01-01T00:00:00Z');

async function ingestAll() {
  const db = openDb(':memory:');
  const store = new SqliteStore(db);
  const result = await runIngest({
    source: new FixtureMailSource('fixtures'),
    store,
    profile: PROFILE,
    query: 'is:unread',
    after: AFTER,
    max: 100,
    maxBodyChars: 8000,
    now: () => 1_700_000_000_000,
  });
  return { db, triage: new SqliteTriageStore(db), messages: result.rows.map((r) => r.message) };
}

function deps(llm: FakeLlmClient, triage: SqliteTriageStore, over: Partial<ClassifyDeps> = {}): ClassifyDeps {
  return {
    llm,
    store: triage,
    profile: PROFILE,
    templates: TEMPLATES,
    temperature: 0.1,
    maxTokens: 4000,
    skipAlreadyClassified: true,
    now: () => 1_700_000_000_000,
    ...over,
  };
}

function pick(messages: NormalizedMessage[], id: string): NormalizedMessage {
  const hit = messages.find((m) => m.messageId === id);
  if (!hit) throw new Error(`Fixture ${id} fehlt`);
  return hit;
}

describe('classifyMessage', () => {
  it('schreibt einen vollständigen Datensatz', async () => {
    const { db, triage, messages } = await ingestAll();
    const llm = new FakeLlmClient([
      answer({
        urgency: 'hoch',
        fields: { sender_name: 'Peter Amrein', contact: '076 444 55 66', location: 'Luzern' },
        missing_fields: ['leistung', 'objektangaben'],
        confidence: 0.9,
      }),
    ]);
    const out = await classifyMessage(pick(messages, 'fix-04'), deps(llm, triage));

    expect(out.kind).toBe('klassifiziert');
    const saved = triage.latestTriage('fix-04');
    expect(saved?.classification).toBe('offertanfrage');
    expect(saved?.urgency).toBe('hoch');
    expect(saved?.senderName).toBe('Peter Amrein');
    expect(saved?.missingFields).toEqual(['leistung', 'objektangaben']);
    expect(saved?.status).toBe('needs_human_review');
    expect(saved?.model).toBe('fake-model');
    expect(saved?.promptVersion).toBe('v1');
    expect(saved?.repairUsed).toBe(false);
    db.close();
  });

  it('status ist immer needs_human_review, auch wenn das Modell etwas anderes schickt', async () => {
    const { db, triage, messages } = await ingestAll();
    const withStatus = JSON.stringify({ ...JSON.parse(answer()), status: 'erledigt' });
    // Zusatzfeld bricht das Schema, der Repair liefert eine saubere Antwort.
    const llm = new FakeLlmClient([withStatus, answer()]);
    await classifyMessage(pick(messages, 'fix-01'), deps(llm, triage));
    expect(triage.latestTriage('fix-01')?.status).toBe('needs_human_review');
    db.close();
  });

  it('hebt VIP-Absender auf hoch und vermerkt die Quelle', async () => {
    const { db, triage, messages } = await ingestAll();
    const llm = new FakeLlmClient([answer({ classification: 'bestandskunde', urgency: 'niedrig' })]);
    await classifyMessage(pick(messages, 'fix-08'), deps(llm, triage));

    const saved = triage.latestTriage('fix-08');
    expect(saved?.urgency).toBe('hoch');
    expect(saved?.urgencySource).toBe('vip_override');
    expect(saved?.classification).toBe('bestandskunde');
    db.close();
  });

  it('senkt eine bereits hohe Dringlichkeit bei VIP nicht ab', async () => {
    const { db, triage, messages } = await ingestAll();
    const llm = new FakeLlmClient([answer({ urgency: 'hoch' })]);
    await classifyMessage(pick(messages, 'fix-09'), deps(llm, triage));
    expect(triage.latestTriage('fix-09')?.urgencySource).toBe('llm');
    db.close();
  });

  it('ruft für ausgeschlossene Absender kein Modell auf', async () => {
    const { db, triage, messages } = await ingestAll();
    const llm = new FakeLlmClient([]);
    const out = await classifyMessage(pick(messages, 'fix-11'), deps(llm, triage));

    expect(out.kind).toBe('ausgeschlossen');
    expect(llm.calls).toHaveLength(0);
    expect(triage.latestTriage('fix-11')).toBeNull();
    db.close();
  });

  it('übergibt Temperatur und Token-Limit an den Adapter', async () => {
    const { db, triage, messages } = await ingestAll();
    const llm = new FakeLlmClient([answer()]);
    await classifyMessage(pick(messages, 'fix-01'), deps(llm, triage));
    expect(llm.calls[0]?.temperature).toBe(0.1);
    expect(llm.calls[0]?.maxTokens).toBe(4000);
    db.close();
  });

  it('stellt Profil und Mailtext in die Prompts', async () => {
    const { db, triage, messages } = await ingestAll();
    const llm = new FakeLlmClient([answer()]);
    await classifyMessage(pick(messages, 'fix-01'), deps(llm, triage));

    expect(llm.calls[0]?.system).toContain('keine Preise hinterlegt');
    expect(llm.calls[0]?.system).toContain('«Gewerk»');
    expect(llm.calls[0]?.user).toContain('Emmenbrücke');
    expect(llm.calls[0]?.user).toContain('Signatur');
    db.close();
  });
});

describe('Repair-Pfad', () => {
  it('repariert einen Schema-Bruch mit genau einem zweiten Versuch', async () => {
    const { db, triage, messages } = await ingestAll();
    const llm = new FakeLlmClient(['{"classification":"offertanfrage"}', answer()]);
    const out = await classifyMessage(pick(messages, 'fix-01'), deps(llm, triage));

    expect(out.kind).toBe('klassifiziert');
    expect(llm.calls).toHaveLength(2);
    expect(triage.latestTriage('fix-01')?.repairUsed).toBe(true);
    db.close();
  });

  it('nennt dem Modell die konkreten Schema-Fehler', async () => {
    const { db, triage, messages } = await ingestAll();
    const llm = new FakeLlmClient(['{"classification":"offertanfrage"}', answer()]);
    await classifyMessage(pick(messages, 'fix-01'), deps(llm, triage));
    expect(llm.calls[1]?.user).toContain('urgency');
    db.close();
  });

  it('gibt nach dem zweiten Bruch auf und legt einen Fallback ab', async () => {
    const { db, triage, messages } = await ingestAll();
    const llm = new FakeLlmClient(['kaputt', 'auch kaputt']);
    const out = await classifyMessage(pick(messages, 'fix-01'), deps(llm, triage));

    expect(out.kind).toBe('fehlgeschlagen');
    expect(llm.calls).toHaveLength(2);
    const saved = triage.latestTriage('fix-01');
    expect(saved?.confidence).toBe(0);
    expect(saved?.reasoning).toMatch(/^schema_error:/);
    expect(saved?.status).toBe('needs_human_review');
    db.close();
  });

  it('überlebt einen Adapter-Fehler, statt den Lauf abzubrechen', async () => {
    const { db, triage, messages } = await ingestAll();
    const llm = new FakeLlmClient(['__THROW__']);
    const out = await classifyMessage(pick(messages, 'fix-01'), deps(llm, triage));

    expect(out.kind).toBe('fehlgeschlagen');
    expect(triage.latestTriage('fix-01')?.reasoning).toContain('Netzwerkfehler');
    db.close();
  });
});

describe('Re-Run-Verhalten', () => {
  it('überspringt bereits klassifizierte Mails', async () => {
    const { db, triage, messages } = await ingestAll();
    const first = new FakeLlmClient([answer()]);
    await classifyMessage(pick(messages, 'fix-01'), deps(first, triage));

    const second = new FakeLlmClient([]);
    const out = await classifyMessage(pick(messages, 'fix-01'), deps(second, triage));

    expect(out.kind).toBe('uebersprungen');
    expect(second.calls).toHaveLength(0);
    db.close();
  });

  it('klassifiziert mit skipAlreadyClassified=false neu und behält die Historie', async () => {
    const { db, triage, messages } = await ingestAll();
    await classifyMessage(pick(messages, 'fix-01'), deps(new FakeLlmClient([answer()]), triage));
    await classifyMessage(
      pick(messages, 'fix-01'),
      deps(new FakeLlmClient([answer({ urgency: 'hoch' })]), triage, {
        skipAlreadyClassified: false,
        now: () => 1_700_000_001_000,
      }),
    );

    expect(triage.latestTriage('fix-01')?.urgency).toBe('hoch');
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM triage_results WHERE message_id = ?')
      .get('fix-01') as { n: number };
    expect(rows.n).toBe(2);
    db.close();
  });
});

describe('runClassify über alle Fixtures', () => {
  it('verarbeitet zwölf Mails ohne Netzwerk und zählt die Ausgänge', async () => {
    const { db, triage, messages } = await ingestAll();
    // Zehn Antworten: die beiden ausgeschlossenen Mails erreichen kein Modell.
    const llm = new FakeLlmClient(Array.from({ length: 10 }, () => answer()));
    const result = await runClassify(messages, deps(llm, triage));

    expect(result.counts).toEqual({
      klassifiziert: 10,
      ausgeschlossen: 2,
      uebersprungen: 0,
      fehlgeschlagen: 0,
      unbearbeitet: 0,
    });
    expect(result.abortedWith).toBeNull();
    expect(llm.calls).toHaveLength(10);
    expect(triage.listTriage(AFTER)).toHaveLength(10);
    db.close();
  });

  it('ein zweiter Lauf ruft kein Modell mehr auf', async () => {
    const { db, triage, messages } = await ingestAll();
    await runClassify(messages, deps(new FakeLlmClient(Array.from({ length: 10 }, () => answer())), triage));

    const second = new FakeLlmClient([]);
    const result = await runClassify(messages, deps(second, triage));
    expect(result.counts['uebersprungen']).toBe(10);
    expect(second.calls).toHaveLength(0);
    db.close();
  });
});

describe('Normalisierung und Klassifikation greifen ineinander', () => {
  it('der Prompt enthält keinen zitierten Verlauf', async () => {
    const { db, triage } = await ingestAll();
    const raw = await new FixtureMailSource('fixtures').get('fix-07');
    const message = normalizeMessage(raw, { maxBodyChars: 8000, now: 0 });
    const llm = new FakeLlmClient([answer({ classification: 'bestandskunde' })]);
    await classifyMessage(message, deps(llm, triage));

    expect(llm.calls[0]?.user).not.toContain('schrieb Betrieb');
    expect(llm.calls[0]?.user).toContain('Ja genau');
    db.close();
  });
});

describe('Fail-Fast bei fatalen Fehlern', () => {
  it('bricht den Lauf ab, statt jede Mail einzeln scheitern zu lassen', async () => {
    const { db, triage, messages } = await ingestAll();
    const llm = new FakeLlmClient(['__FATAL__']);
    const result = await runClassify(messages, deps(llm, triage));

    expect(llm.calls).toHaveLength(1);
    expect(result.abortedWith).toContain('Ungültiger Schlüssel');
    expect(result.counts['unbearbeitet']).toBe(12);
    expect(triage.listTriage(AFTER)).toHaveLength(0);
    db.close();
  });

  it('behält verarbeitete Mails, wenn der Abbruch mitten im Lauf kommt', async () => {
    const { db, triage, messages } = await ingestAll();
    const llm = new FakeLlmClient([answer(), answer(), '__FATAL__']);
    const result = await runClassify(messages, deps(llm, triage));

    expect(result.counts['klassifiziert']).toBe(2);
    expect(result.counts['unbearbeitet']).toBeGreaterThan(0);
    expect(triage.listTriage(AFTER)).toHaveLength(2);
    db.close();
  });

  it('ein gewöhnlicher Netzwerkfehler bricht den Lauf nicht ab', async () => {
    const { db, triage, messages } = await ingestAll();
    const llm = new FakeLlmClient([
      '__THROW__',
      ...Array.from({ length: 9 }, () => answer()),
    ]);
    const result = await runClassify(messages, deps(llm, triage));

    expect(result.abortedWith).toBeNull();
    expect(result.counts['fehlgeschlagen']).toBe(1);
    expect(result.counts['klassifiziert']).toBe(9);
    db.close();
  });
});
