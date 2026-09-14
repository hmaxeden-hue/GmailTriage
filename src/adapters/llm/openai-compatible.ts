import { FatalLlmError } from '../../core/errors.js';
import type { LlmClient } from '../../core/ports.js';

/**
 * Für LM Studio, Ollama und andere OpenAI-kompatible Endpunkte — gedacht für
 * ein lokales Qwen. Bewusst ohne SDK: es geht um einen einzigen POST.
 *
 * Auf diesem Pfad verlässt kein Mailinhalt den Rechner, solange baseUrl auf
 * localhost zeigt.
 */
export interface OpenAiCompatibleOptions {
  model: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatibleClient implements LlmClient {
  readonly provider = 'openai-compatible' as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: OpenAiCompatibleOptions) {
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async complete(req: {
    system: string;
    user: string;
    temperature: number;
    maxTokens: number;
  }): Promise<{ text: string; model: string; usage?: { input: number; output: number } }> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const message = `${this.baseUrl} antwortete ${res.status}: ${body}`;
      // Schlüssel, Berechtigung oder Modellname stimmen nicht — jede weitere
      // Mail liefe in denselben Fehler.
      if ([400, 401, 403, 404].includes(res.status)) throw new FatalLlmError(message);
      throw new Error(message);
    }

    const data = (await res.json()) as ChatCompletion;
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('Leere Antwort vom OpenAI-kompatiblen Endpunkt.');

    const usage =
      data.usage?.prompt_tokens !== undefined && data.usage.completion_tokens !== undefined
        ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens }
        : undefined;

    return { text, model: this.model, ...(usage ? { usage } : {}) };
  }
}
