import { z } from 'zod';

/** config/app.yaml — Laufzeit- und Anbieterwahl. Keine Geheimnisse hier drin. */
export const AppConfig = z.object({
  gmail: z.object({
    /** Basisfilter ohne Zeitfenster; das Zeitfenster kommt aus --since. */
    query: z.string().default('is:unread -category:promotions -category:social'),
    maxResults: z.number().int().positive().max(500).default(100),
    credentialsPath: z.string().default('config/credentials.json'),
    tokenPath: z.string().default('config/token.json'),
  }).default({}),

  llm: z.object({
    provider: z.enum(['anthropic', 'openai-compatible']).default('anthropic'),
    /** Wird in CP2 gesetzt und befuellt; hier bewusst noch leer. */
    model: z.string().default(''),
    baseUrl: z.string().optional(),
    /**
     * Wird nur an Modelle gereicht, die Sampling noch unterstuetzen.
     * Anthropic-Modelle ab der 4.7-Generation lehnen den Parameter ab.
     */
    temperature: z.number().min(0).max(1).default(0.1),
    maxTokens: z.number().int().positive().default(4000),
    /** Denktiefe bei Anthropic. Klassifikation kommt mit low aus. */
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
    /** Serverseitiger Ausweichpfad, falls das Modell eine Mail ablehnt. */
    refusalFallback: z.boolean().default(true),
  }).default({}),

  ingest: z.object({
    maxBodyChars: z.number().int().positive().default(8000),
    defaultSince: z.string().default('7d'),
  }).default({}),

  telegram: z.object({
    enabled: z.boolean().default(false),
    chatId: z.string().optional(),
  }).default({}),

  storage: z.object({
    dbPath: z.string().default('data/triage.db'),
    outDir: z.string().default('out'),
  }).default({}),
});
export type AppConfig = z.infer<typeof AppConfig>;

/** config/profile.yaml — Betriebsprofil. «...» bleibt unausgefuellt stehen. */
export const ProfileConfig = z.object({
  betrieb: z.object({
    name: z.string(),
    gewerk: z.string(),
    ort: z.string(),
    email: z.string(),
    telefon: z.string().nullable().default(null),
  }),
  leistungen: z.array(z.string()).default([]),
  einzugsgebiet: z.array(z.string()).default([]),
  kapazitaet: z.string().nullable().default(null),
  /** null bedeutet ausdruecklich: keine Preise hinterlegt. Nie erfinden. */
  preisliste: z.array(z.object({ leistung: z.string(), preis: z.string() })).nullable().default(null),
  vipAbsender: z.array(z.string()).default([]),
  ausschluss: z.object({
    absender: z.array(z.string()).default([]),
    domains: z.array(z.string()).default([]),
    betreffMuster: z.array(z.string()).default([]),
  }).default({}),
});
export type ProfileConfig = z.infer<typeof ProfileConfig>;

/** true, wenn der Wert noch ein unausgefuellter Platzhalter ist. */
export function isPlaceholder(value: string | null | undefined): boolean {
  return typeof value === 'string' && /«[^»]*»/.test(value);
}
