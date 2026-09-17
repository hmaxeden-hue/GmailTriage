import { describe, expect, it } from 'vitest';
import { LlmTriage, describeIssues, extractJson } from '../src/core/llm-schema.js';
import { answer } from './helpers/fake-llm.js';

describe('extractJson', () => {
  it('liest blankes JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('schält einen Markdown-Codeblock ab', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('überspringt eine Präambel', () => {
    expect(extractJson('Gerne! Hier das Ergebnis:\n{"a":1}\nViel Erfolg.')).toEqual({ a: 1 });
  });

  it('wirft bei Text ohne JSON', () => {
    expect(() => extractJson('Dazu kann ich nichts sagen.')).toThrow();
  });
});

describe('LlmTriage', () => {
  it('nimmt eine vollständige Antwort an', () => {
    expect(LlmTriage.safeParse(JSON.parse(answer())).success).toBe(true);
  });

  it('lässt null in jedem Feld zu', () => {
    const parsed = LlmTriage.parse(JSON.parse(answer()));
    expect(parsed.fields.contact).toBeNull();
  });

  it('weist einen halluzinierten Preis als Zusatzfeld ab', () => {
    const broken = { ...JSON.parse(answer()), preis: "CHF 2'400" };
    const res = LlmTriage.safeParse(broken);
    expect(res.success).toBe(false);
    expect(res.success === false && describeIssues(res.error)).toMatch(/preis/i);
  });

  it('weist ein Zusatzfeld innerhalb von fields ab', () => {
    const base = JSON.parse(answer()) as { fields: Record<string, unknown> };
    base.fields['stundensatz'] = '95';
    expect(LlmTriage.safeParse(base).success).toBe(false);
  });

  it('weist unbekannte Klassifikationen ab', () => {
    expect(LlmTriage.safeParse({ ...JSON.parse(answer()), classification: 'spam' }).success).toBe(false);
  });

  it('weist erfundene missing_fields ab', () => {
    expect(
      LlmTriage.safeParse({ ...JSON.parse(answer()), missing_fields: ['farbe'] }).success,
    ).toBe(false);
  });

  it('weist confidence ausserhalb 0..1 ab', () => {
    expect(LlmTriage.safeParse({ ...JSON.parse(answer()), confidence: 1.5 }).success).toBe(false);
  });

  it('beschreibt Fehler mit Pfad', () => {
    const res = LlmTriage.safeParse({ classification: 'offertanfrage' });
    expect(res.success === false && describeIssues(res.error)).toContain('urgency');
  });
});
