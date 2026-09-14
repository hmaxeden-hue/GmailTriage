import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_MAX_BODY_CHARS,
  decodeEntities,
  htmlToText,
  normalizeMessage,
  parseAddress,
  selectBody,
  splitSignature,
  stripQuotes,
} from '../src/core/normalize.js';
import { toRawMessage } from '../src/adapters/gmail/client.js';

const fixture = (file: string) =>
  toRawMessage(JSON.parse(readFileSync(`fixtures/${file}`, 'utf8')));

const opts = { maxBodyChars: DEFAULT_MAX_BODY_CHARS, now: 1_700_000_000_000 };

describe('htmlToText', () => {
  it('entfernt style/script und erhält Umlaute', () => {
    const out = htmlToText('<style>p{}</style><p>Gr&uuml;ezi &amp; hallo</p><p>Zeile</p>');
    expect(out).toBe('Grüezi & hallo\n\nZeile');
  });

  it('macht aus Listen Aufzählungszeilen', () => {
    expect(htmlToText('<ul><li>A</li><li>B</li></ul>')).toBe('- A\n- B');
  });

  it('dekodiert numerische Entities', () => {
    expect(decodeEntities('&#8364;&#x20AC;')).toBe('€€');
  });
});

describe('stripQuotes', () => {
  it('schneidet bei >-Zitaten ab', () => {
    expect(stripQuotes('Meine Antwort\n\n> alte Mail\n> noch mehr')).toBe('Meine Antwort');
  });

  it('erkennt "Am ... schrieb ...:"', () => {
    const text = 'Ja passt.\n\nAm 12. September 2026 um 14:03 schrieb Betrieb <b@e.ch>:\n> Frage?';
    expect(stripQuotes(text)).toBe('Ja passt.');
  });

  it('erkennt "-----Ursprüngliche Nachricht-----"', () => {
    const text = 'Kurz.\n-----Ursprüngliche Nachricht-----\nVon: X\nalter Text';
    expect(stripQuotes(text)).toBe('Kurz.');
  });

  it('erkennt Outlook-Kopfzeilen', () => {
    expect(stripQuotes('Neu.\n\nVon: A <a@b.ch>\nGesendet: Montag\nAlt.')).toBe('Neu.');
  });
});

describe('splitSignature', () => {
  it('trennt am RFC-Marker "-- "', () => {
    const { body, signature } = splitSignature('Text\n\n-- \nRegula\nAG\n+41 41 222 33 44');
    expect(body).toBe('Text');
    expect(signature).toContain('Regula');
  });

  it('erkennt einen Kontaktblock ohne Marker', () => {
    const { body, signature } = splitSignature(
      'Bitte um Offerte.\n\nMartina Rüegg\nSeestrasse 12, 6020 Emmenbrücke\nm@example.ch',
    );
    expect(body).toContain('Bitte um Offerte.');
    expect(signature).toContain('example.ch');
  });

  it('lässt Text ohne Signatur unangetastet', () => {
    const { body, signature } = splitSignature('Hallo, was kostet das? Danke');
    expect(body).toBe('Hallo, was kostet das? Danke');
    expect(signature).toBeNull();
  });

  it('verwirft die Signatur nicht — Kontaktdaten bleiben erhalten', () => {
    const m = normalizeMessage(fixture('01-klar-renovation.json'), opts);
    expect(m.signatureText).toContain('m.rueegg@example.ch');
    expect(m.signatureText).toContain('6020 Emmenbrücke');
  });
});

describe('parseAddress', () => {
  it('trennt Anzeigename und Adresse', () => {
    expect(parseAddress('Martina Rüegg <M.Rueegg@Example.ch>')).toEqual({
      name: 'Martina Rüegg',
      email: 'm.rueegg@example.ch',
    });
  });

  it('kommt ohne Anzeigename aus', () => {
    expect(parseAddress('j.keller@example.ch')).toEqual({ name: null, email: 'j.keller@example.ch' });
  });

  it('entfernt Anführungszeichen', () => {
    expect(parseAddress('"Sandra Bieri" <s@example.org>').name).toBe('Sandra Bieri');
  });
});

describe('selectBody', () => {
  it('bevorzugt text/plain', () => {
    expect(selectBody(fixture('02-klar-neubau.json').payload).source).toBe('plain');
  });

  it('fällt auf HTML zurück', () => {
    const { source, text } = selectBody(fixture('03-klar-html.json').payload);
    expect(source).toBe('html');
    expect(text).toContain('Kostenvoranschlag');
  });

  it('sammelt Anhangsnamen statt Inhalte', () => {
    const { attachments } = selectBody(fixture('02-klar-neubau.json').payload);
    expect(attachments).toEqual(['ausschreibung.pdf']);
  });
});

describe('normalizeMessage', () => {
  it('füllt die Kopfdaten', () => {
    const m = normalizeMessage(fixture('01-klar-renovation.json'), opts);
    expect(m.fromEmail).toBe('m.rueegg@example.ch');
    expect(m.fromName).toBe('Martina Rüegg');
    expect(m.subject).toBe('Offerte Renovation Wohnung Emmenbrücke');
    expect(m.rfc822Id).toBe('<fix-01@mail.example.com>');
    expect(m.truncated).toBe(false);
  });

  it('entfernt den zitierten Verlauf', () => {
    const m = normalizeMessage(fixture('07-vage-thread.json'), opts);
    expect(m.bodyText).toBe('Ja genau, so hatte ich das gemeint. Passt das bei Ihnen?');
  });

  it('kappt zu lange Bodies und markiert das', () => {
    const raw = fixture('01-klar-renovation.json');
    const m = normalizeMessage(raw, { ...opts, maxBodyChars: 40 });
    expect(m.truncated).toBe(true);
    expect(m.bodyText).toContain('…gekürzt');
  });

  it('liefert für jede Fixture einen nicht-leeren Body', () => {
    const files = [
      '01-klar-renovation.json', '02-klar-neubau.json', '03-klar-html.json',
      '04-klar-dringend.json', '05-vage-kurz.json', '06-vage-ohne-ort.json',
      '07-vage-thread.json', '08-vip-stammkunde.json', '09-vip-dringend.json',
      '10-nicht-newsletter.json', '11-nicht-rechnung.json', '12-nicht-bewerbung.json',
    ];
    for (const f of files) {
      const m = normalizeMessage(fixture(f), opts);
      expect(m.bodyText.length, f).toBeGreaterThan(0);
      expect(m.bodyHash, f).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('ist deterministisch — gleicher Input, gleicher Hash', () => {
    const a = normalizeMessage(fixture('05-vage-kurz.json'), opts);
    const b = normalizeMessage(fixture('05-vage-kurz.json'), { ...opts, now: 1 });
    expect(a.bodyHash).toBe(b.bodyHash);
  });
});
