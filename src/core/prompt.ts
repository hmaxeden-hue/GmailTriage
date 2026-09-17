import type { ProfileConfig } from '../config/schema.js';
import type { NormalizedMessage } from './types.js';

/**
 * Prompt-Aufbau als reine Funktionen. Die Vorlagen selbst liegen in prompts/
 * mit Versionsnummer im Dateinamen und werden hier nur befüllt.
 */

export interface PromptTemplates {
  system: string;
  user: string;
  repair: string;
  /** Version aus den Dateinamen, wandert in triage_results.prompt_version. */
  version: string;
}

/** Betriebsprofil als knapper Text für den System-Prompt. */
export function renderProfile(profile: ProfileConfig): string {
  const lines: string[] = [
    `Betrieb: ${profile.betrieb.name}`,
    `Gewerk: ${profile.betrieb.gewerk}`,
    `Standort: ${profile.betrieb.ort}`,
  ];

  lines.push(
    profile.leistungen.length
      ? `Leistungen: ${profile.leistungen.join(', ')}`
      : 'Leistungen: nicht hinterlegt',
  );
  lines.push(
    profile.einzugsgebiet.length
      ? `Einzugsgebiet: ${profile.einzugsgebiet.join(', ')}`
      : 'Einzugsgebiet: nicht hinterlegt',
  );
  if (profile.kapazitaet) lines.push(`Kapazität: ${profile.kapazitaet}`);

  // Regel 2: ohne hinterlegte Preise darf nirgends eine Zahl entstehen.
  lines.push(
    profile.preisliste === null || profile.preisliste.length === 0
      ? 'Preise: keine Preise hinterlegt'
      : `Preise: ${profile.preisliste.map((p) => `${p.leistung} — ${p.preis}`).join('; ')}`,
  );

  return lines.join('\n');
}

export function renderSystemPrompt(template: string, profile: ProfileConfig): string {
  return template.replace('{{PROFIL}}', renderProfile(profile));
}

export function renderUserPrompt(template: string, m: NormalizedMessage): string {
  const absender = m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail;
  const signatur = m.signatureText
    ? `--- Signatur des Absenders ---\n${m.signatureText}\n--- Ende Signatur ---`
    : '(keine Signatur erkannt)';

  return template
    .replace('{{ABSENDER}}', absender)
    .replace('{{BETREFF}}', m.subject ?? '(kein Betreff)')
    .replace('{{DATUM}}', new Date(m.internalDate).toISOString())
    .replace('{{BODY}}', m.bodyText)
    .replace('{{SIGNATUR}}', signatur);
}

export function renderRepairPrompt(template: string, answer: string, issues: string): string {
  return template.replace('{{FEHLER}}', issues).replace('{{ANTWORT}}', answer);
}
