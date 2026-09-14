import type { ProfileConfig } from '../config/schema.js';
import { isPlaceholder } from '../config/schema.js';
import type { MissingField } from './llm-schema.js';
import type { NormalizedMessage, TriageRecord } from './types.js';

/**
 * Antwortentwuerfe. Reine Funktionen, kein Modell im Spiel: der Text entsteht
 * aus dem Betriebsprofil und den fehlenden Angaben, nicht aus Generierung.
 *
 * Regel 2 in Textform: hier steht nie ein Preis, nie ein zugesagter Termin und
 * nie eine Frist. Fehlt etwas, wird gefragt.
 */

export type DraftKind = 'rueckfrage' | 'eingangsbestaetigung';

export interface DraftText {
  kind: DraftKind;
  subject: string;
  body: string;
}

const FRAGEN_SIE: Record<MissingField, string> = {
  kontakt: 'Unter welcher Telefonnummer erreichen wir Sie am besten?',
  ort: 'Wo genau befindet sich das Objekt?',
  leistung: 'Welche Arbeiten sollen ausgeführt werden?',
  termin: 'In welchem Zeitraum soll die Arbeit stattfinden?',
  objektangaben: 'Um was für ein Objekt handelt es sich — Art, Grösse, Baujahr, Zustand?',
  budget: 'Haben Sie einen Kostenrahmen im Sinn?',
  umfang: 'Wie gross ist der Umfang ungefähr?',
};

const FRAGEN_DU: Record<MissingField, string> = {
  kontakt: 'Unter welcher Telefonnummer erreichen wir dich am besten?',
  ort: 'Wo genau befindet sich das Objekt?',
  leistung: 'Welche Arbeiten sollen ausgeführt werden?',
  termin: 'In welchem Zeitraum soll die Arbeit stattfinden?',
  objektangaben: 'Um was für ein Objekt handelt es sich — Art, Grösse, Baujahr, Zustand?',
  budget: 'Hast du einen Kostenrahmen im Sinn?',
  umfang: 'Wie gross ist der Umfang ungefähr?',
};

export function questionFor(field: string, anrede: 'sie' | 'du'): string | null {
  const table = anrede === 'du' ? FRAGEN_DU : FRAGEN_SIE;
  return table[field as MissingField] ?? null;
}

/** "Re: X" — aber nicht "Re: Re: X". */
export function replySubject(subject: string | null): string {
  const base = (subject ?? '(kein Betreff)').trim();
  return /^(re|aw|antw)\s*:/i.test(base) ? base : `Re: ${base}`;
}

function greeting(name: string | null, anrede: 'sie' | 'du'): string {
  if (!name) return 'Guten Tag';
  return anrede === 'du' ? `Hallo ${name}` : `Guten Tag ${name}`;
}

function signature(profile: ProfileConfig): string {
  if (profile.signatur && !isPlaceholder(profile.signatur)) return profile.signatur;
  const parts = [profile.betrieb.name, profile.betrieb.ort].filter(
    (v) => v && !isPlaceholder(v),
  );
  return parts.length ? parts.join('\n') : profile.betrieb.name;
}

/**
 * Der Kapazitaetshinweis stammt aus dem Profil und ist damit eine Angabe des
 * Betriebs, keine Erfindung. Ein unausgefuellter Platzhalter bleibt draussen.
 */
function capacityNote(profile: ProfileConfig): string | null {
  if (!profile.kapazitaet || isPlaceholder(profile.kapazitaet)) return null;
  return `Zur aktuellen Auslastung: ${profile.kapazitaet}`;
}

export function buildDraft(
  message: NormalizedMessage,
  triage: TriageRecord,
  profile: ProfileConfig,
): DraftText {
  const anrede = profile.anrede;
  const name = triage.senderName ?? message.fromName;
  const questions = triage.missingFields
    .map((f) => questionFor(f, anrede))
    .filter((q): q is string => q !== null);

  const kind: DraftKind = questions.length > 0 ? 'rueckfrage' : 'eingangsbestaetigung';
  const blocks: string[] = [greeting(name, anrede)];

  blocks.push(
    anrede === 'du'
      ? 'besten Dank für deine Anfrage.'
      : 'besten Dank für Ihre Anfrage.',
  );

  if (kind === 'rueckfrage') {
    blocks.push(
      anrede === 'du'
        ? 'Damit wir dir ein passendes Angebot rechnen können, fehlen uns noch ein paar Angaben:'
        : 'Damit wir Ihnen ein passendes Angebot rechnen können, fehlen uns noch ein paar Angaben:',
    );
    blocks.push(questions.map((q) => `- ${q}`).join('\n'));
    blocks.push(
      anrede === 'du'
        ? 'Sobald wir das wissen, melden wir uns mit einem konkreten Vorschlag.'
        : 'Sobald wir das wissen, melden wir uns mit einem konkreten Vorschlag.',
    );
  } else {
    blocks.push(
      anrede === 'du'
        ? 'Wir haben sie erhalten und schauen sie uns an. Wir melden uns bei dir.'
        : 'Wir haben sie erhalten und schauen sie uns an. Wir melden uns bei Ihnen.',
    );
  }

  const capacity = capacityNote(profile);
  if (capacity) blocks.push(capacity);

  // Gruss und Signatur bilden einen Block — dazwischen gehoert keine Leerzeile.
  blocks.push(`Freundliche Grüsse\n${signature(profile)}`);

  return { kind, subject: replySubject(message.subject), body: blocks.join('\n\n') };
}

/** Für welche Einordnungen überhaupt ein Entwurf entsteht. */
export function needsDraft(triage: TriageRecord): boolean {
  return triage.classification !== 'sonstiges';
}
