import type { ProfileConfig } from '../config/schema.js';
import { isVip } from './exclusion.js';
import type { LlmTriage } from './llm-schema.js';
import { URGENCIES } from './llm-schema.js';
import type { NormalizedMessage, TriageRecord } from './types.js';

export interface TriageMeta {
  provider: string;
  model: string;
  promptVersion: string;
  repairUsed: boolean;
  now: number;
}

const RANK: Record<(typeof URGENCIES)[number], number> = { niedrig: 0, normal: 1, hoch: 2 };

/** Hebt auf mindestens `hoch` an, senkt aber nie ab. */
export function applyVipFloor(
  urgency: TriageRecord['urgency'],
  vip: boolean,
): { urgency: TriageRecord['urgency']; source: TriageRecord['urgencySource'] } {
  if (!vip || RANK[urgency] >= RANK.hoch) return { urgency, source: 'llm' };
  return { urgency: 'hoch', source: 'vip_override' };
}

/** Setzt die validierte Modellantwort mit den lokalen Regeln zusammen. */
export function toTriageRecord(
  message: NormalizedMessage,
  llm: LlmTriage,
  profile: ProfileConfig,
  meta: TriageMeta,
): TriageRecord {
  const { urgency, source } = applyVipFloor(llm.urgency, isVip(message, profile));

  return {
    messageId: message.messageId,
    classification: llm.classification,
    urgency,
    urgencySource: source,
    senderName: llm.fields.sender_name,
    contact: llm.fields.contact,
    location: llm.fields.location,
    service: llm.fields.service,
    desiredDate: llm.fields.desired_date,
    objectInfo: llm.fields.object_info,
    budgetHint: llm.fields.budget_hint,
    missingFields: llm.missing_fields,
    status: 'needs_human_review',
    confidence: llm.confidence,
    reasoning: llm.reasoning,
    provider: meta.provider,
    model: meta.model,
    promptVersion: meta.promptVersion,
    repairUsed: meta.repairUsed,
    createdAt: meta.now,
  };
}

/**
 * Wenn auch der Repair-Versuch am Schema scheitert, wird der Lauf nicht
 * abgebrochen. Die Mail bekommt einen Datensatz mit confidence 0, damit sie
 * in der Durchsicht auftaucht statt lautlos zu verschwinden.
 */
export function toFallbackRecord(
  message: NormalizedMessage,
  reason: string,
  meta: TriageMeta,
): TriageRecord {
  return {
    messageId: message.messageId,
    classification: 'sonstiges',
    urgency: 'niedrig',
    urgencySource: 'llm',
    senderName: null,
    contact: null,
    location: null,
    service: null,
    desiredDate: null,
    objectInfo: null,
    budgetHint: null,
    missingFields: [],
    status: 'needs_human_review',
    confidence: 0,
    reasoning: `schema_error: ${reason}`.slice(0, 400),
    provider: meta.provider,
    model: meta.model,
    promptVersion: meta.promptVersion,
    repairUsed: meta.repairUsed,
    createdAt: meta.now,
  };
}
