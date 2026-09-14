import { describe, expect, it } from 'vitest';
import { digestDateStamp, digestFilename, renderDigest, renderUrgentNotice } from '../src/core/digest.js';
import type { DigestItem } from '../src/core/digest.js';
import type { DraftRecord, NormalizedMessage, TriageRecord } from '../src/core/types.js';

function message(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'm1', threadId: 't1', rfc822Id: null,
    fromName: 'Martina Rüegg', fromEmail: 'm@example.ch', toEmail: null,
    subject: 'Offerte Renovation', internalDate: Date.parse('2026-09-14T08:00:00+02:00'),
    bodyText: 'x', signatureText: null, bodyHash: 'h', labelIds: [],
    truncated: false, ingestedAt: 0, ...over,
  };
}

function triage(over: Partial<TriageRecord> = {}): TriageRecord {
  return {
    messageId: 'm1', classification: 'offertanfrage', urgency: 'normal', urgencySource: 'llm',
    senderName: null, contact: null, location: null, service: null, desiredDate: null,
    objectInfo: null, budgetHint: null, missingFields: [], status: 'needs_human_review',
    confidence: 0.8, reasoning: null, provider: 'anthropic', model: 'm',
    promptVersion: 'v1', repairUsed: false, createdAt: 0, ...over,
  };
}

function draft(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    messageId: 'm1', threadId: 't1', gmailDraftId: 'd1', kind: 'rueckfrage',
    body: 'x', dryRun: false, createdAt: 0, ...over,
  };
}

const DATE = new Date('2026-09-14T18:00:00+02:00');

describe('digestFilename', () => {
  it('benennt nach Ortszeit-Datum', () => {
    expect(digestFilename(new Date('2026-09-14T23:30:00'))).toBe('digest-2026-09-14.md');
    expect(digestDateStamp(new Date('2026-01-05T10:00:00'))).toBe('2026-01-05');
  });
});

describe('renderDigest', () => {
  it('sortiert nach Dringlichkeit', () => {
    const items: DigestItem[] = [
      { message: message({ messageId: 'a' }), triage: triage({ urgency: 'niedrig', senderName: 'Niedrig' }), draft: null },
      { message: message({ messageId: 'b' }), triage: triage({ urgency: 'hoch', senderName: 'Hoch' }), draft: null },
      { message: message({ messageId: 'c' }), triage: triage({ urgency: 'normal', senderName: 'Normal' }), draft: null },
    ];
    const out = renderDigest(items, { date: DATE, sonstige: 0 });
    expect(out.indexOf('Hoch')).toBeLessThan(out.indexOf('Normal'));
    expect(out.indexOf('Normal')).toBeLessThan(out.indexOf('Niedrig'));
    expect(out).toContain('## Dringend');
  });

  it('sortiert innerhalb einer Stufe nach Zeit, neueste zuerst', () => {
    const items: DigestItem[] = [
      {
        message: message({ messageId: 'alt', internalDate: Date.parse('2026-09-13T08:00:00+02:00') }),
        triage: triage({ senderName: 'Älter' }), draft: null,
      },
      {
        message: message({ messageId: 'neu', internalDate: Date.parse('2026-09-14T08:00:00+02:00') }),
        triage: triage({ senderName: 'Neuer' }), draft: null,
      },
    ];
    const out = renderDigest(items, { date: DATE, sonstige: 0 });
    expect(out.indexOf('Neuer')).toBeLessThan(out.indexOf('Älter'));
  });

  it('gibt je Eintrag genau zwei Zeilen aus', () => {
    const items: DigestItem[] = [{ message: message(), triage: triage(), draft: draft() }];
    const out = renderDigest(items, { date: DATE, sonstige: 0 });
    const block = out.split('## Normal\n\n')[1]?.trimEnd() ?? '';
    expect(block.split('\n')).toHaveLength(2);
  });

  it('nennt Absender, Betreff und Zeitpunkt in der ersten Zeile', () => {
    const out = renderDigest([{ message: message(), triage: triage(), draft: null }], {
      date: DATE, sonstige: 0,
    });
    expect(out).toContain('**Martina Rüegg** — Offerte Renovation');
    expect(out).toMatch(/14\.09\., 08:00/);
  });

  it('zieht den extrahierten Namen dem Header-Namen vor', () => {
    const out = renderDigest(
      [{ message: message(), triage: triage({ senderName: 'M. Rüegg-Meier' }), draft: null }],
      { date: DATE, sonstige: 0 },
    );
    expect(out).toContain('**M. Rüegg-Meier**');
  });

  it('listet fehlende Angaben in der zweiten Zeile', () => {
    const out = renderDigest(
      [{ message: message(), triage: triage({ missingFields: ['ort', 'termin'] }), draft: null }],
      { date: DATE, sonstige: 0 },
    );
    expect(out).toContain('fehlt: ort, termin');
  });

  it('unterscheidet berechneten und angelegten Entwurf', () => {
    const angelegt = renderDigest([{ message: message(), triage: triage(), draft: draft() }], {
      date: DATE, sonstige: 0,
    });
    const berechnet = renderDigest(
      [{ message: message(), triage: triage(), draft: draft({ dryRun: true, gmailDraftId: null }) }],
      { date: DATE, sonstige: 0 },
    );
    expect(angelegt).toContain('Entwurf liegt bereit');
    expect(berechnet).toContain('Entwurf berechnet');
  });

  it('markiert VIP und unsichere Einordnungen', () => {
    const out = renderDigest(
      [{
        message: message(),
        triage: triage({ urgencySource: 'vip_override', urgency: 'hoch', confidence: 0.3 }),
        draft: null,
      }],
      { date: DATE, sonstige: 0 },
    );
    expect(out).toContain('VIP');
    expect(out).toContain('unsicher (0.30)');
  });

  it('lässt sonstiges aus der Durchsicht, zählt es aber', () => {
    const items: DigestItem[] = [
      { message: message({ messageId: 'a', subject: 'Newsletter' }), triage: triage({ classification: 'sonstiges' }), draft: null },
      { message: message({ messageId: 'b' }), triage: triage(), draft: null },
    ];
    const out = renderDigest(items, { date: DATE, sonstige: 3 });
    expect(out).not.toContain('Newsletter');
    expect(out).toContain('3 sonstige');
  });

  it('sagt es deutlich, wenn nichts anliegt', () => {
    expect(renderDigest([], { date: DATE, sonstige: 5 })).toContain('Keine Anfragen im Zeitraum.');
  });

  it('erinnert an die menschliche Freigabe', () => {
    expect(renderDigest([], { date: DATE, sonstige: 0 })).toContain('Freigabe');
  });

  it('nennt keine Zahl, die aus einer Mail stammen könnte', () => {
    const out = renderDigest(
      [{ message: message(), triage: triage({ service: 'Renovation', location: 'Emmenbrücke' }), draft: null }],
      { date: DATE, sonstige: 0 },
    );
    // Erlaubt sind Datum, Uhrzeit und die Zähler der Kopfzeile.
    const body = out.split('## Normal')[1] ?? '';
    expect(body).not.toMatch(/CHF|EUR|Franken/);
  });
});

describe('renderUrgentNotice', () => {
  it('überträgt keinen Mailtext', () => {
    const item: DigestItem = {
      message: message({ bodyText: 'Vertraulicher Inhalt mit Adresse' }),
      triage: triage({ urgency: 'hoch', missingFields: ['ort'] }),
      draft: null,
    };
    const notice = renderUrgentNotice(item);
    expect(notice).not.toContain('Vertraulicher Inhalt');
    expect(notice).toContain('Martina Rüegg');
    expect(notice).toContain('Offerte Renovation');
    expect(notice).toContain('Fehlt: ort');
  });
});

describe('Kopfzeile', () => {
  it('schreibt das Datum ohne doppelten Punkt', () => {
    const out = renderDigest([], { date: DATE, sonstige: 0 });
    expect(out.split('\n')[0]).toBe('# Tagesdigest 14.09.2026');
  });
});
