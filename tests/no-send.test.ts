import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  SCOPES_DRAFT,
  SCOPES_DRAFT_LABEL,
  SCOPES_READONLY,
  scopesFor,
} from '../src/adapters/gmail/auth.js';

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
  { pattern: /auth\/gmail\.send\b/, why: 'Sende-Scope' },
  { pattern: /mail\.google\.com/, why: 'Vollzugriff-Scope' },
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

  it('fordert ohne Entwürfe nur den Lese-Scope an', () => {
    expect(SCOPES_READONLY).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
    expect(scopesFor({ drafts: false, label: false })).toEqual(SCOPES_READONLY);
    expect(scopesFor({ drafts: false, label: true })).toEqual(SCOPES_READONLY);
  });

  it('nimmt für Entwürfe genau gmail.compose dazu', () => {
    expect(SCOPES_DRAFT).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ]);
    expect(scopesFor({ drafts: true, label: false })).toEqual(SCOPES_DRAFT);
  });

  it('fordert den breiteren Label-Scope nur an, wenn ein Label konfiguriert ist', () => {
    expect(SCOPES_DRAFT_LABEL).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(scopesFor({ drafts: true, label: true })).toEqual(SCOPES_DRAFT_LABEL);
    expect(scopesFor({ drafts: true, label: false })).not.toContain(
      'https://www.googleapis.com/auth/gmail.modify',
    );
  });

  it('keine Scope-Liste enthält einen ausdrücklichen Sende-Scope', () => {
    for (const list of [SCOPES_READONLY, SCOPES_DRAFT, SCOPES_DRAFT_LABEL]) {
      expect(list).not.toContain('https://www.googleapis.com/auth/gmail.send');
      expect(list).not.toContain('https://mail.google.com/');
    }
  });

  it('der Entwurfs-Adapter ruft drafts.create und nichts mit send', () => {
    const src = readFileSync('src/adapters/gmail/draft.ts', 'utf8');
    expect(src).toContain('users.drafts.create');
    expect(src).not.toMatch(/\.send\s*\(/);
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
