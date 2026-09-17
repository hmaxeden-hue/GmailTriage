import Anthropic from '@anthropic-ai/sdk';
import { FatalLlmError } from '../../core/errors.js';
import type { LlmClient } from '../../core/ports.js';

/**
 * Modelle ab der 4.7-Generation haben die Sampling-Parameter entfernt:
 * temperature, top_p und top_k werden mit HTTP 400 abgelehnt.
 * Siehe README, Abschnitt "Temperatur 0.1".
 */
const SAMPLING_UNSUPPORTED =
  /^claude-(opus-5|opus-4-8|opus-4-7|sonnet-5|fable-5|mythos-5)/;

export function supportsTemperature(model: string): boolean {
  return !SAMPLING_UNSUPPORTED.test(model);
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicOptions {
  model: string;
  /** Klassifikation braucht keine tiefe Analyse; low hält Kosten und Latenz tief. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Serverseitiger Ausweichpfad, falls das Modell eine Mail ablehnt. */
  refusalFallback?: boolean;
  apiKey?: string;
}

export class AnthropicClient implements LlmClient {
  readonly provider = 'anthropic' as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: NonNullable<AnthropicOptions['effort']>;
  private readonly refusalFallback: boolean;

  constructor(opts: AnthropicOptions) {
    this.model = opts.model;
    this.effort = opts.effort ?? 'low';
    this.refusalFallback = opts.refusalFallback ?? true;
    this.client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : new Anthropic();
  }

  /** Trennt Fehler, die den ganzen Lauf betreffen, von solchen einer Mail. */
  private async request(req: {
    system: string;
    user: string;
    temperature: number;
    maxTokens: number;
  }): Promise<Anthropic.Beta.BetaMessage> {
    try {
      return await this.client.beta.messages.create({
        model: this.model,
        max_tokens: req.maxTokens,
        // Der System-Prompt ist über einen Lauf hinweg identisch; das Caching
        // spart ab der zweiten Mail. Greift es nicht, kostet es nichts.
        cache_control: { type: 'ephemeral' },
        system: req.system,
        output_config: { effort: this.effort },
        ...(supportsTemperature(this.model) ? { temperature: req.temperature } : {}),
        ...(this.refusalFallback
          ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const }
          : {}),
        messages: [{ role: 'user', content: req.user }],
      });
    } catch (err: unknown) {
      if (
        err instanceof Anthropic.AuthenticationError ||
        err instanceof Anthropic.PermissionDeniedError ||
        err instanceof Anthropic.NotFoundError ||
        err instanceof Anthropic.BadRequestError
      ) {
        throw new FatalLlmError(
          `Anthropic lehnt die Anfrage grundsätzlich ab (HTTP ${err.status}): ${err.message}`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  async complete(req: {
    system: string;
    user: string;
    temperature: number;
    maxTokens: number;
  }): Promise<{ text: string; model: string; usage?: { input: number; output: number } }> {
    const response = await this.request(req);

    if (response.stop_reason === 'refusal') {
      throw new Error(
        `Modell hat die Mail abgelehnt (${response.stop_details?.category ?? 'ohne Kategorie'}).`,
      );
    }

    // Nur Textblöcke; thinking-Blöcke enthalten kein JSON.
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return {
      text,
      // Bei einem serverseitigen Ausweichpfad ist das nicht das angefragte
      // Modell — deshalb wird die Antwort und nicht die Config persistiert.
      model: response.model,
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    };
  }
}
