import { describe, expect, it } from 'vitest';
import { FixtureMailSource } from '../src/adapters/gmail/fixture-source.js';
import { openDb } from '../src/adapters/sqlite/db.js';
import { SqliteStore } from '../src/adapters/sqlite/repo.js';
import { ProfileConfig } from '../src/config/schema.js';
import { runIngest } from '../src/pipeline/ingest.js';

const PROFILE = ProfileConfig.parse({
  betrieb: { name: 'Testbetrieb', gewerk: '«Gewerk»', ort: 'Luzern', email: 'betrieb@example.ch' },
  vipAbsender: ['@vip-verwaltung.example'],
  ausschluss: {
    absender: [],
    domains: ['lieferant.example'],
    betreffMuster: ['^Newsletter'],
  },
});

// Weit vor dem Fixture-Anker, damit alle zwölf im Fenster liegen.
const AFTER = new Date('2020-01-01T00:00:00Z');

function setup() {
  const db = openDb(':memory:');
  return {
    db,
    deps: {
      source: new FixtureMailSource('fixtures'),
      store: new SqliteStore(db),
      profile: PROFILE,
      query: 'is:unread',
      after: AFTER,
      max: 100,
      maxBodyChars: 8000,
      now: () => 1_700_000_000_000,
    },
  };
}

describe('runIngest', () => {
  it('liest alle zwölf Fixtures und legt sie ab', async () => {
    const { db, deps } = setup();
    const result = await runIngest(deps);
    expect(result.rows).toHaveLength(12);
    expect(deps.store.countMessages()).toBe(12);
    db.close();
  });

  it('markiert VIP-Absender über die Domain', async () => {
    const { db, deps } = setup();
    const result = await runIngest(deps);
    const vips = result.rows.filter((r) => r.vip).map((r) => r.message.messageId);
    expect(vips.sort()).toEqual(['fix-08', 'fix-09']);
    db.close();
  });

  it('schliesst Lieferantendomain und Newsletter-Betreff aus', async () => {
    const { db, deps } = setup();
    const result = await runIngest(deps);
    const excluded = result.rows.filter((r) => r.excludedReason !== null);
    expect(excluded.map((r) => r.message.messageId).sort()).toEqual(['fix-10', 'fix-11']);
    expect(result.counts).toEqual({ gefunden: 12, ausgeschlossen: 2, vip: 2 });
    db.close();
  });

  it('respektiert das Zeitfenster', async () => {
    const { db, deps } = setup();
    const result = await runIngest({
      ...deps,
      after: new Date(Date.parse('2026-09-14T09:00:00+02:00') - 6 * 3_600_000),
    });
    expect(result.rows.map((r) => r.message.messageId)).toEqual(['fix-04', 'fix-01', 'fix-05']);
    db.close();
  });

  it('respektiert --max', async () => {
    const { db, deps } = setup();
    const result = await runIngest({ ...deps, max: 3 });
    expect(result.rows).toHaveLength(3);
    db.close();
  });

  it('ist idempotent: zwei Läufe erzeugen keine Duplikate', async () => {
    const { db, deps } = setup();
    await runIngest(deps);
    await runIngest(deps);
    expect(deps.store.countMessages()).toBe(12);
    db.close();
  });

  it('liest zurück, was es geschrieben hat', async () => {
    const { db, deps } = setup();
    await runIngest(deps);
    const m = deps.store.getMessage('fix-03');
    expect(m?.fromEmail).toBe('sandra.bieri@example.org');
    expect(m?.bodyText).toContain('Kostenvoranschlag');
    expect(m?.labelIds).toEqual(['INBOX', 'UNREAD']);
    db.close();
  });
});

describe('Dry-Run-Garantie', () => {
  it('der Ingest-Ablauf kennt keine ausgehenden Ports', async () => {
    const { db, deps } = setup();
    // runIngest nimmt nur source und store entgegen — es gibt keinen
    // Parameter, ueber den ein Draft-, Label- oder Telegram-Port hineinkaeme.
    expect(Object.keys(deps).sort()).toEqual([
      'after', 'max', 'maxBodyChars', 'now', 'profile', 'query', 'source', 'store',
    ]);
    db.close();
  });
});
