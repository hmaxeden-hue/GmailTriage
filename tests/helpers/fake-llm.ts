import { FatalLlmError } from '../../src/core/errors.js';
import type { LlmClient } from '../../src/core/ports.js';

export interface FakeCall {
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Ersetzt den echten Adapter in Tests. Die Suite macht keine Netzwerk-Calls;
 * geprüft wird die Verdrahtung — Schema, Repair, Override, Persistenz —,
 * nicht die Urteilsqualität eines Modells.
 */
export class FakeLlmClient implements LlmClient {
  readonly provider = 'anthropic' as const;
  readonly model: string;
  readonly calls: FakeCall[] = [];
  private queue: string[];

  constructor(responses: string[], model = 'fake-model') {
    this.queue = [...responses];
    this.model = model;
  }

  async complete(req: FakeCall): Promise<{ text: string; model: string }> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('FakeLlmClient: keine Antwort mehr in der Queue');
    if (next === '__THROW__') throw new Error('Netzwerkfehler (simuliert)');
    if (next === '__FATAL__') throw new FatalLlmError('Ungültiger Schlüssel (simuliert)');
    return { text: next, model: this.model };
  }
}

export function answer(over: Partial<{
  classification: string;
  urgency: string;
  fields: Record<string, string | null>;
  missing_fields: string[];
  confidence: number;
  reasoning: string;
}> = {}): string {
  return JSON.stringify({
    classification: 'offertanfrage',
    urgency: 'normal',
    fields: {
      sender_name: null,
      contact: null,
      location: null,
      service: null,
      desired_date: null,
      object_info: null,
      budget_hint: null,
      ...(over.fields ?? {}),
    },
    missing_fields: over.missing_fields ?? ['kontakt'],
    confidence: over.confidence ?? 0.8,
    reasoning: over.reasoning ?? 'Testantwort.',
    ...(over.classification ? { classification: over.classification } : {}),
    ...(over.urgency ? { urgency: over.urgency } : {}),
  });
}
