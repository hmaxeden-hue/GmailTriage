import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PromptTemplates } from '../core/prompt.js';

/**
 * Laedt die versionierten Prompt-Dateien. Die Version steht im Dateinamen und
 * wird pro Datensatz persistiert, damit spaetere Auswertungen wissen, welcher
 * Prompt ein Ergebnis erzeugt hat.
 */
export function loadPromptTemplates(dir = 'prompts', version = 'v1'): PromptTemplates {
  return {
    system: readFileSync(join(dir, `triage.system.${version}.md`), 'utf8'),
    user: readFileSync(join(dir, `triage.user.${version}.md`), 'utf8'),
    repair: readFileSync(join(dir, `repair.${version}.md`), 'utf8'),
    version,
  };
}
