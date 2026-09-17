import { describe, expect, it } from 'vitest';
import { ProfileConfig } from '../src/config/schema.js';
import { buildRfc822, encodeHeaderWord, sanitizeHeaderValue, toBase64Url } from '../src/core/mime.js';
import { buildDraft, needsDraft, questionFor, replySubject } from '../src/core/reply.js';
import type { NormalizedMessage, TriageRecord } from '../src/core/types.js';

const MESSAGE: NormalizedMessage = {
  messageId: 'm1', threadId: 't1', rfc822Id: '<m1@mail.example.com>',
  fromName: 'Martina Rüegg', fromEmail: 'm.rueegg@example.ch', toEmail: 'b@example.ch',
  subject: 'Offerte Renovation', internalDate: 1_700_000_000_000,
  bodyText: 'Bitte um Offerte.', signatureText: null,
  bodyHash: 'x', labelIds: [], truncated: false, ingestedAt: 0,
};

const TRIAGE: TriageRecord = {
  messageId: 'm1', classification: 'offertanfrage', urgency: 'normal', urgencySource: 'llm',
  senderName: 'Martina Rüegg', contact: null, location: null, service: null,
  desiredDate: null, objectInfo: null, budgetHint: null,
  missingFields: ['ort', 'termin'], status: 'needs_human_review',
  confidence: 0.8, reasoning: 'Test', provider: 'anthropic', model: 'm',
  promptVersion: 'v1', repairUsed: false, createdAt: 0,
};

const PROFILE = ProfileConfig.parse({
  betrieb: { name: 'Muster AG', gewerk: '«Gewerk»', ort: 'Luzern', email: 'b@example.ch' },
});

describe('replySubject', () => {
  it('setzt Re: davor', () => {
    expect(replySubject('Offerte')).toBe('Re: Offerte');
  });

  it('verdoppelt Re:, AW: und Antw: nicht', () => {
    expect(replySubject('Re: Offerte')).toBe('Re: Offerte');
    expect(replySubject('AW: Offerte')).toBe('AW: Offerte');
    expect(replySubject('Antw: Offerte')).toBe('Antw: Offerte');
  });

  it('kommt ohne Betreff aus', () => {
    expect(replySubject(null)).toBe('Re: (kein Betreff)');
  });
});

describe('buildDraft — Regel 2 im Text', () => {
  it('enthält keinen Geldbetrag', () => {
    const { body } = buildDraft(MESSAGE, TRIAGE, PROFILE);
    expect(body).not.toMatch(/\b(CHF|EUR|Fr\.|€)\b/i);
    expect(body).not.toMatch(/\d+['´’]?\d*\s*(Franken|Euro)/i);
  });

  it('nennt keine Zahl, die als Preis oder Frist lesbar wäre', () => {
    const { body } = buildDraft(MESSAGE, TRIAGE, PROFILE);
    expect(body).not.toMatch(/\d/);
  });

  it('sagt keinen Termin und keine Frist zu', () => {
    const { body } = buildDraft(MESSAGE, TRIAGE, PROFILE);
    expect(body).not.toMatch(/innerhalb|spätestens|garantiert|bis morgen|24 Stunden|Werktag/i);
  });

  it('erfindet keine Leistung aus dem Profil', () => {
    const profile = ProfileConfig.parse({
      betrieb: { name: 'Muster AG', gewerk: '«Gewerk»', ort: 'Luzern', email: 'b@example.ch' },
      leistungen: ['Nassraumsanierung'],
    });
    expect(buildDraft(MESSAGE, TRIAGE, profile).body).not.toContain('Nassraumsanierung');
  });
});

describe('buildDraft — Rückfrage', () => {
  it('fragt genau die fehlenden Angaben ab', () => {
    const draft = buildDraft(MESSAGE, TRIAGE, PROFILE);
    expect(draft.kind).toBe('rueckfrage');
    expect(draft.body).toContain(questionFor('ort', 'sie'));
    expect(draft.body).toContain(questionFor('termin', 'sie'));
    expect(draft.body).not.toContain(questionFor('budget', 'sie'));
  });

  it('spricht den Absender mit Namen an', () => {
    expect(buildDraft(MESSAGE, TRIAGE, PROFILE).body).toContain('Guten Tag Martina Rüegg');
  });

  it('kommt ohne Namen aus, statt einen zu erfinden', () => {
    const anonym = { ...MESSAGE, fromName: null };
    const triage = { ...TRIAGE, senderName: null };
    const body = buildDraft(anonym, triage, PROFILE).body;
    expect(body.startsWith('Guten Tag\n')).toBe(true);
  });

  it('ignoriert ein unbekanntes missing_field, statt daran zu scheitern', () => {
    const triage = { ...TRIAGE, missingFields: ['ort', 'farbe'] };
    expect(buildDraft(MESSAGE, triage, PROFILE).body).toContain(questionFor('ort', 'sie'));
  });
});

describe('buildDraft — Eingangsbestätigung', () => {
  it('entsteht, wenn nichts fehlt', () => {
    const draft = buildDraft(MESSAGE, { ...TRIAGE, missingFields: [] }, PROFILE);
    expect(draft.kind).toBe('eingangsbestaetigung');
    expect(draft.body).toContain('Wir haben sie erhalten');
  });

  it('verspricht keinen Zeitpunkt für die Rückmeldung', () => {
    const body = buildDraft(MESSAGE, { ...TRIAGE, missingFields: [] }, PROFILE).body;
    expect(body).toMatch(/Wir melden uns bei Ihnen\./);
    expect(body).not.toMatch(/heute|morgen|Tagen|Stunden/i);
  });
});

describe('buildDraft — Profilbausteine', () => {
  it('duzt auf Wunsch', () => {
    const profile = ProfileConfig.parse({
      betrieb: { name: 'Muster AG', gewerk: '«Gewerk»', ort: 'Luzern', email: 'b@example.ch' },
      anrede: 'du',
    });
    const body = buildDraft(MESSAGE, TRIAGE, profile).body;
    expect(body).toContain('Hallo Martina Rüegg');
    expect(body).toContain('für deine Anfrage');
  });

  it('nimmt die Signatur aus dem Profil', () => {
    const profile = ProfileConfig.parse({
      betrieb: { name: 'Muster AG', gewerk: '«Gewerk»', ort: 'Luzern', email: 'b@example.ch' },
      signatur: 'Muster AG\nLuzern\n041 000 00 00',
    });
    expect(buildDraft(MESSAGE, TRIAGE, profile).body).toContain('041 000 00 00');
  });

  it('gibt einen hinterlegten Kapazitätshinweis weiter', () => {
    const profile = ProfileConfig.parse({
      betrieb: { name: 'Muster AG', gewerk: '«Gewerk»', ort: 'Luzern', email: 'b@example.ch' },
      kapazitaet: 'aktuell ausgebucht bis Ende Jahr',
    });
    expect(buildDraft(MESSAGE, TRIAGE, profile).body).toContain('ausgebucht bis Ende Jahr');
  });

  it('lässt einen unausgefüllten Kapazitäts-Platzhalter draussen', () => {
    const profile = ProfileConfig.parse({
      betrieb: { name: 'Muster AG', gewerk: '«Gewerk»', ort: 'Luzern', email: 'b@example.ch' },
      kapazitaet: 'ausgebucht bis KW «xx»',
    });
    expect(buildDraft(MESSAGE, TRIAGE, profile).body).not.toContain('«xx»');
  });

  it('schreibt keinen Platzhalter in die Signatur', () => {
    const profile = ProfileConfig.parse({
      betrieb: { name: '«Betriebsname»', gewerk: '«Gewerk»', ort: '«Ort»', email: 'b@example.ch' },
    });
    const body = buildDraft(MESSAGE, TRIAGE, profile).body;
    expect(body).toContain('«Betriebsname»'); // unverändert stehen gelassen, nicht erfunden
  });
});

describe('needsDraft', () => {
  it('überspringt sonstiges', () => {
    expect(needsDraft({ ...TRIAGE, classification: 'sonstiges' })).toBe(false);
  });

  it('gilt für Anfragen und Bestandskunden', () => {
    expect(needsDraft(TRIAGE)).toBe(true);
    expect(needsDraft({ ...TRIAGE, classification: 'bestandskunde' })).toBe(true);
  });
});

describe('MIME', () => {
  it('setzt die Thread-Header für die Antwort', () => {
    const raw = buildRfc822({
      from: 'b@example.ch', to: 'm@example.ch', subject: 'Re: Test',
      inReplyTo: '<m1@mail.example.com>', body: 'Hallo',
    });
    expect(raw).toContain('In-Reply-To: <m1@mail.example.com>');
    expect(raw).toContain('References: <m1@mail.example.com>');
  });

  it('lässt die Thread-Header weg, wenn keine Message-ID bekannt ist', () => {
    const raw = buildRfc822({
      from: 'b@example.ch', to: 'm@example.ch', subject: 'Test', inReplyTo: null, body: 'Hallo',
    });
    expect(raw).not.toContain('In-Reply-To');
  });

  it('kodiert Umlaute im Betreff nach RFC 2047', () => {
    expect(encodeHeaderWord('Rückfrage')).toMatch(/^=\?UTF-8\?B\?/);
    expect(encodeHeaderWord('Plain subject')).toBe('Plain subject');
  });

  it('überträgt den Body verlustfrei', () => {
    const body = 'Grüezi\n\n- Wo genau?\n\nFreundliche Grüsse';
    const raw = buildRfc822({
      from: 'b@example.ch', to: 'm@example.ch', subject: 'x', inReplyTo: null, body,
    });
    const encoded = raw.split('\r\n\r\n')[1] ?? '';
    expect(Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(body);
  });

  it('wehrt Header-Injection ab', () => {
    expect(sanitizeHeaderValue('Test\r\nBcc: fremd@example.com')).toBe('Test Bcc: fremd@example.com');
    const raw = buildRfc822({
      from: 'b@example.ch', to: 'm@example.ch',
      subject: 'Hallo\r\nBcc: fremd@example.com', inReplyTo: null, body: 'x',
    });
    expect(raw.split('\r\n\r\n')[0]).not.toMatch(/^Bcc:/m);
  });

  it('liefert base64url ohne Padding', () => {
    expect(toBase64Url('ü?>')).not.toMatch(/[+/=]/);
  });
});
