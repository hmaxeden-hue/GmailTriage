import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { supportsTemperature } from '../src/adapters/llm/index.js';
import { loadPromptTemplates } from '../src/adapters/prompts.js';
import { ProfileConfig } from '../src/config/schema.js';
import { renderProfile, renderSystemPrompt, renderUserPrompt } from '../src/core/prompt.js';
import { applyVipFloor, toFallbackRecord, toTriageRecord } from '../src/core/triage.js';
import type { NormalizedMessage } from '../src/core/types.js';
import { answer } from './helpers/fake-llm.js';
import { LlmTriage } from '../src/core/llm-schema.js';

const MESSAGE: NormalizedMessage = {
  messageId: 'm1', threadId: 't1', rfc822Id: '<m1@x>',
  fromName: 'Test Person', fromEmail: 'test@example.ch', toEmail: 'b@example.ch',
  subject: 'Anfrage', internalDate: 1_700_000_000_000,
  bodyText: 'Bitte um Offerte.', signatureText: 'Tel. 041 555 00 00',
  bodyHash: 'x', labelIds: [], truncated: false, ingestedAt: 0,
};

const META = { provider: 'anthropic', model: 'm', promptVersion: 'v1', repairUsed: false, now: 42 };

describe('applyVipFloor', () => {
  it('hebt niedrig und normal auf hoch', () => {
    expect(applyVipFloor('niedrig', true)).toEqual({ urgency: 'hoch', source: 'vip_override' });
    expect(applyVipFloor('normal', true)).toEqual({ urgency: 'hoch', source: 'vip_override' });
  });

  it('lässt hoch unverändert und schreibt es dem Modell zu', () => {
    expect(applyVipFloor('hoch', true)).toEqual({ urgency: 'hoch', source: 'llm' });
  });

  it('rührt Nicht-VIP nicht an', () => {
    expect(applyVipFloor('niedrig', false)).toEqual({ urgency: 'niedrig', source: 'llm' });
  });
});

describe('toTriageRecord', () => {
  const profile = ProfileConfig.parse({
    betrieb: { name: 'X', gewerk: '«Gewerk»', ort: 'Luzern', email: 'b@example.ch' },
  });

  it('setzt status hart auf needs_human_review', () => {
    const rec = toTriageRecord(MESSAGE, LlmTriage.parse(JSON.parse(answer())), profile, META);
    expect(rec.status).toBe('needs_human_review');
  });

  it('übernimmt Modell, Provider und Prompt-Version', () => {
    const rec = toTriageRecord(MESSAGE, LlmTriage.parse(JSON.parse(answer())), profile, META);
    expect(rec).toMatchObject({ provider: 'anthropic', model: 'm', promptVersion: 'v1' });
  });
});

describe('toFallbackRecord', () => {
  it('bleibt sichtbar statt zu verschwinden', () => {
    const rec = toFallbackRecord(MESSAGE, 'urgency fehlt', META);
    expect(rec.confidence).toBe(0);
    expect(rec.classification).toBe('sonstiges');
    expect(rec.status).toBe('needs_human_review');
    expect(rec.reasoning).toBe('schema_error: urgency fehlt');
  });

  it('kappt überlange Fehlertexte', () => {
    expect(toFallbackRecord(MESSAGE, 'x'.repeat(900), META).reasoning?.length).toBeLessThanOrEqual(400);
  });
});

describe('renderProfile', () => {
  it('sagt ausdrücklich, dass keine Preise hinterlegt sind', () => {
    const p = ProfileConfig.parse({
      betrieb: { name: 'X', gewerk: '«Gewerk»', ort: 'Luzern', email: 'b@example.ch' },
    });
    expect(renderProfile(p)).toContain('keine Preise hinterlegt');
  });

  it('behandelt eine leere Preisliste wie keine', () => {
    const p = ProfileConfig.parse({
      betrieb: { name: 'X', gewerk: '«Gewerk»', ort: 'Luzern', email: 'b@example.ch' },
      preisliste: [],
    });
    expect(renderProfile(p)).toContain('keine Preise hinterlegt');
  });

  it('gibt hinterlegte Preise weiter', () => {
    const p = ProfileConfig.parse({
      betrieb: { name: 'X', gewerk: '«Gewerk»', ort: 'Luzern', email: 'b@example.ch' },
      preisliste: [{ leistung: 'Stundenansatz', preis: 'CHF 95' }],
    });
    expect(renderProfile(p)).toContain('Stundenansatz — CHF 95');
  });

  it('lässt Platzhalter unangetastet stehen', () => {
    const p = ProfileConfig.parse({
      betrieb: { name: '«Betriebsname»', gewerk: '«Gewerk»', ort: '«Ort»', email: 'b@example.ch' },
    });
    expect(renderProfile(p)).toContain('«Betriebsname»');
  });
});

describe('Prompt-Vorlagen', () => {
  const t = loadPromptTemplates();
  const profile = ProfileConfig.parse({
    betrieb: { name: 'X', gewerk: '«Gewerk»', ort: 'Luzern', email: 'b@example.ch' },
  });

  it('verbietet erfundene Angaben ausdrücklich', () => {
    expect(t.system).toMatch(/Erfinde nichts/i);
    expect(t.system).toMatch(/Preise, Termine, Fristen/i);
  });

  it('ersetzt alle Marken im System-Prompt', () => {
    expect(renderSystemPrompt(t.system, profile)).not.toContain('{{');
  });

  it('ersetzt alle Marken im User-Prompt', () => {
    expect(renderUserPrompt(t.user, MESSAGE)).not.toContain('{{');
  });

  it('reicht die Signatur separat mit', () => {
    expect(renderUserPrompt(t.user, MESSAGE)).toContain('041 555 00 00');
  });

  it('meldet eine fehlende Signatur statt sie zu erfinden', () => {
    const out = renderUserPrompt(t.user, { ...MESSAGE, signatureText: null });
    expect(out).toContain('keine Signatur erkannt');
  });

  it('trägt die Version im Dateinamen', () => {
    const files = readdirSync('prompts');
    expect(files.every((f) => /\.v\d+\.md$/.test(f))).toBe(true);
    expect(t.version).toBe('v1');
  });
});

describe('supportsTemperature', () => {
  it('meldet die Modelle, die Sampling entfernt haben', () => {
    for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5-1']) {
      expect(supportsTemperature(m), m).toBe(false);
    }
  });

  it('meldet die Modelle, die Temperatur noch annehmen', () => {
    for (const m of ['claude-haiku-4-5', 'claude-sonnet-4-6', 'qwen2.5-14b-instruct']) {
      expect(supportsTemperature(m), m).toBe(true);
    }
  });
});

describe('keine Netzwerk-Calls in der Suite', () => {
  it('kein Test instanziiert einen echten Adapter', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith('.ts') && /new (AnthropicClient|OpenAiCompatibleClient|GmailMailSource)\(/.test(readFileSync(path, 'utf8'))) {
          offenders.push(path);
        }
      }
    };
    walk('tests');
    expect(offenders).toEqual([]);
  });
});
