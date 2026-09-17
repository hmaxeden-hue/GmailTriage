import type { ProfileConfig } from '../config/schema.js';
import { FatalLlmError } from '../core/errors.js';
import { checkExclusion } from '../core/exclusion.js';
import { describeIssues, extractJson, LlmTriage } from '../core/llm-schema.js';
import type { LlmClient, TriageStore } from '../core/ports.js';
import {
  renderRepairPrompt,
  renderSystemPrompt,
  renderUserPrompt,
  type PromptTemplates,
} from '../core/prompt.js';
import { toFallbackRecord, toTriageRecord } from '../core/triage.js';
import type { NormalizedMessage, TriageRecord } from '../core/types.js';

export type ClassifyOutcome =
  | { kind: 'klassifiziert'; record: TriageRecord }
  | { kind: 'ausgeschlossen'; reason: string }
  | { kind: 'uebersprungen'; record: TriageRecord }
  | { kind: 'fehlgeschlagen'; record: TriageRecord; error: string };

export interface ClassifyResult {
  outcomes: Array<{ message: NormalizedMessage; outcome: ClassifyOutcome }>;
  counts: Record<string, number>;
  /** Gesetzt, wenn der Lauf vorzeitig endete — z.B. ungültiger Schlüssel. */
  abortedWith: string | null;
}

export interface ClassifyDeps {
  llm: LlmClient;
  store: TriageStore;
  profile: ProfileConfig;
  templates: PromptTemplates;
  temperature: number;
  maxTokens: number;
  /** false: bereits klassifizierte Mails erneut durch das Modell schicken. */
  skipAlreadyClassified: boolean;
  now: () => number;
}

/**
 * Klassifiziert eine einzelne Mail. Bei Schema-Bruch folgt genau ein
 * Repair-Versuch; scheitert auch der, entsteht ein Fallback-Datensatz statt
 * eines Abbruchs — die Mail soll in der Durchsicht auftauchen.
 */
export async function classifyMessage(
  message: NormalizedMessage,
  deps: ClassifyDeps,
): Promise<ClassifyOutcome> {
  const exclusion = checkExclusion(message, deps.profile);
  if (exclusion.excluded) {
    return { kind: 'ausgeschlossen', reason: exclusion.reason ?? 'Ausschlussliste' };
  }

  if (deps.skipAlreadyClassified) {
    const existing = deps.store.latestTriage(message.messageId);
    if (existing) return { kind: 'uebersprungen', record: existing };
  }

  const system = renderSystemPrompt(deps.templates.system, deps.profile);
  const user = renderUserPrompt(deps.templates.user, message);
  const meta = {
    provider: deps.llm.provider,
    model: deps.llm.model,
    promptVersion: deps.templates.version,
    repairUsed: false,
    now: deps.now(),
  };

  let answer = '';
  try {
    const first = await deps.llm.complete({
      system,
      user,
      temperature: deps.temperature,
      maxTokens: deps.maxTokens,
    });
    answer = first.text;
    meta.model = first.model;

    const parsed = LlmTriage.safeParse(safeExtract(answer));
    if (parsed.success) {
      const record = toTriageRecord(message, parsed.data, deps.profile, meta);
      deps.store.insertTriage(record);
      return { kind: 'klassifiziert', record };
    }

    // Ein Repair-Versuch, mehr nicht.
    const issues = parsed.error ? describeIssues(parsed.error) : 'Antwort war kein gültiges JSON';
    const repaired = await deps.llm.complete({
      system,
      user: renderRepairPrompt(deps.templates.repair, answer, issues),
      temperature: deps.temperature,
      maxTokens: deps.maxTokens,
    });
    meta.repairUsed = true;
    meta.model = repaired.model;

    const second = LlmTriage.safeParse(safeExtract(repaired.text));
    if (second.success) {
      const record = toTriageRecord(message, second.data, deps.profile, meta);
      deps.store.insertTriage(record);
      return { kind: 'klassifiziert', record };
    }

    const reason = second.error ? describeIssues(second.error) : 'Antwort war kein gültiges JSON';
    const record = toFallbackRecord(message, reason.replace(/\n/g, ' '), meta);
    deps.store.insertTriage(record);
    return { kind: 'fehlgeschlagen', record, error: reason };
  } catch (err: unknown) {
    // Betrifft den ganzen Lauf, nicht diese Mail — nach oben durchreichen.
    if (err instanceof FatalLlmError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    const record = toFallbackRecord(message, reason, meta);
    deps.store.insertTriage(record);
    return { kind: 'fehlgeschlagen', record, error: reason };
  }
}

/** JSON-Extraktion darf den Lauf nicht mit einer Ausnahme beenden. */
function safeExtract(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return null;
  }
}

export async function runClassify(
  messages: NormalizedMessage[],
  deps: ClassifyDeps,
): Promise<ClassifyResult> {
  const outcomes: ClassifyResult['outcomes'] = [];
  const counts: Record<string, number> = {
    klassifiziert: 0,
    ausgeschlossen: 0,
    uebersprungen: 0,
    fehlgeschlagen: 0,
    unbearbeitet: 0,
  };

  let abortedWith: string | null = null;

  for (const [index, message] of messages.entries()) {
    try {
      const outcome = await classifyMessage(message, deps);
      counts[outcome.kind] = (counts[outcome.kind] ?? 0) + 1;
      outcomes.push({ message, outcome });
    } catch (err: unknown) {
      if (!(err instanceof FatalLlmError)) throw err;
      // Keine weiteren Anläufe: der Fehler gilt für jede Mail gleichermassen.
      abortedWith = err.message;
      counts['unbearbeitet'] = messages.length - index;
      break;
    }
  }

  return { outcomes, counts, abortedWith };
}
