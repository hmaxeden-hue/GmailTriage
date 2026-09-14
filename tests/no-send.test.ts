import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SCOPES_READONLY } from '../src/adapters/gmail/auth.js';

/**
 * Harte Regel 1: Ausgehende Mails entstehen ausschliesslich als Entwurf.
 * Diese Tests sind die Reissleine — sie schlagen fehl, sobald irgendwo im
 * Quelltext ein Sendeweg auftaucht.
 */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\bmessages\s*\.\s*send\b/, why: 'Gmail users.messages.send' },
  { pattern: /\bdrafts\s*\.\s*send\b/, why: 'Gmail users.drafts.send' },
  { pattern: /\bsendMessage\b/, why: 'Sendeaufruf' },
  { pattern: /gmail\.send\b/, why: 'Sende-Scope' },
  { pattern: /gmail\.modify\b/, why: 'Scope mit Sendewirkung' },
];

describe('niemals senden', () => {
  const files = sourceFiles('src');

  it('findet überhaupt Quelldateien', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const { pattern, why } of FORBIDDEN) {
    it(`kein Vorkommen von ${why}`, () => {
      const hits = files.filter((f) => pattern.test(readFileSync(f, 'utf8')));
      expect(hits, `${why} gefunden in: ${hits.join(', ')}`).toEqual([]);
    });
  }

  it('fordert in CP1 nur den Lese-Scope an', () => {
    expect(SCOPES_READONLY).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
  });

  it('der DraftSink-Port bietet keine Sendemethode an', () => {
    const ports = readFileSync('src/core/ports.ts', 'utf8');
    const block = ports.slice(ports.indexOf('interface DraftSink'));
    const body = block.slice(0, block.indexOf('\n}'));
    expect(body).not.toMatch(/\bsend\b/);
    expect(body).toMatch(/createReplyDraft/);
  });
});

describe('Trennung der Schichten', () => {
  /** Alle Modulpfade, aus denen eine Datei importiert. */
  function imports(file: string): string[] {
    return [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
  }

  it('core/ importiert nichts aus adapters/', () => {
    const offenders = sourceFiles('src/core').filter((f) =>
      imports(f).some((spec) => spec.includes('adapters/')),
    );
    expect(offenders).toEqual([]);
  });

  it('core/ importiert weder better-sqlite3 noch ein Anbieter-SDK', () => {
    const forbidden = /^(better-sqlite3|@googleapis\/|@anthropic-ai\/|openai$)/;
    const offenders = sourceFiles('src/core').filter((f) =>
      imports(f).some((spec) => forbidden.test(spec)),
    );
    expect(offenders).toEqual([]);
  });
});
