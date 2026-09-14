import { describe, expect, it } from 'vitest';
import { parseSince } from '../src/config/load.js';
import { AppConfig, ProfileConfig, isPlaceholder } from '../src/config/schema.js';

describe('parseSince', () => {
  it('rechnet Tage, Stunden und Minuten um', () => {
    expect(parseSince('7d')).toBe(604_800_000);
    expect(parseSince('48h')).toBe(172_800_000);
    expect(parseSince('90m')).toBe(5_400_000);
  });

  it('weist Unsinn mit klarer Meldung ab', () => {
    expect(() => parseSince('bald')).toThrow(/Ungültiges Zeitfenster/);
    expect(() => parseSince('7w')).toThrow();
  });
});

describe('AppConfig', () => {
  it('setzt sichere Defaults', () => {
    const cfg = AppConfig.parse({});
    expect(cfg.telegram.enabled).toBe(false);
    expect(cfg.llm.temperature).toBe(0.1);
    expect(cfg.gmail.query).toBe('is:unread -category:promotions -category:social');
  });

  it('lehnt unbekannte Provider ab', () => {
    expect(() => AppConfig.parse({ llm: { provider: 'gemini' } })).toThrow();
  });
});

describe('ProfileConfig', () => {
  it('behandelt fehlende Preisliste als "keine Preise hinterlegt"', () => {
    const p = ProfileConfig.parse({
      betrieb: { name: 'X', gewerk: '«Gewerk»', ort: 'Luzern', email: 'a@b.ch' },
    });
    expect(p.preisliste).toBeNull();
  });

  it('erkennt unausgefüllte Platzhalter', () => {
    expect(isPlaceholder('«Gewerk»')).toBe(true);
    expect(isPlaceholder('Schreinerei')).toBe(false);
    expect(isPlaceholder(null)).toBe(false);
  });
});
