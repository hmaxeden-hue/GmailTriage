import { z } from 'zod';

/**
 * Schema der LLM-Antwort. .strict() ist Absicht: taucht ein Feld auf, das
 * hier nicht steht — etwa ein halluzinierter Preis —, bricht die Validierung,
 * statt den Wert stillschweigend durchzulassen.
 */

export const MISSING_FIELDS = [
  'kontakt',
  'ort',
  'leistung',
  'termin',
  'objektangaben',
  'budget',
  'umfang',
] as const;
export type MissingField = (typeof MISSING_FIELDS)[number];

export const CLASSIFICATIONS = ['offertanfrage', 'bestandskunde', 'sonstiges'] as const;
export const URGENCIES = ['hoch', 'normal', 'niedrig'] as const;

const ExtractedField = z.string().trim().min(1).max(200).nullable();

export const LlmTriage = z
  .object({
    classification: z.enum(CLASSIFICATIONS),
    urgency: z.enum(URGENCIES),
    fields: z
      .object({
        sender_name: ExtractedField,
        contact: ExtractedField,
        location: ExtractedField,
        service: ExtractedField,
        desired_date: ExtractedField,
        object_info: ExtractedField,
        budget_hint: ExtractedField,
      })
      .strict(),
    missing_fields: z.array(z.enum(MISSING_FIELDS)).max(MISSING_FIELDS.length),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().trim().min(1).max(400),
  })
  .strict();

export type LlmTriage = z.infer<typeof LlmTriage>;

/** Kurzfassung der Zod-Fehler für den Repair-Prompt. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `- ${i.path.join('.') || '(Wurzel)'}: ${i.message}`)
    .join('\n');
}

/**
 * Holt das JSON aus der Modellantwort. Modelle verpacken es gern in einen
 * Codeblock oder stellen einen Satz voran, obwohl der Prompt es verbietet.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? sliceOutermostObject(text) ?? text;
  return JSON.parse(candidate.trim()) as unknown;
}

function sliceOutermostObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end > start ? text.slice(start, end + 1) : null;
}
