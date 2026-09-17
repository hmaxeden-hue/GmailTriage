import type { AppConfig } from '../../config/schema.js';
import type { LlmClient } from '../../core/ports.js';
import { AnthropicClient } from './anthropic.js';
import { OpenAiCompatibleClient } from './openai-compatible.js';

export { AnthropicClient, supportsTemperature } from './anthropic.js';
export { OpenAiCompatibleClient } from './openai-compatible.js';

/**
 * Die Modellwahl steht in der Config, nicht im Code. Ein Wechsel zwischen
 * Anthropic und lokalem Qwen ist eine Zeile in config/app.yaml.
 */
export function createLlmClient(cfg: AppConfig['llm'], modelOverride?: string): LlmClient {
  const model = modelOverride ?? cfg.model;
  if (!model) {
    throw new Error(
      'Kein Modell gewählt. Setze llm.model in config/app.yaml oder übergib --model=...',
    );
  }

  if (cfg.provider === 'anthropic') {
    if (!process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_AUTH_TOKEN']) {
      throw new Error(
        'ANTHROPIC_API_KEY ist nicht gesetzt. Alternativ auf llm.provider: openai-compatible ' +
          'mit einem lokalen Modell wechseln.',
      );
    }
    return new AnthropicClient({ model, effort: cfg.effort, refusalFallback: cfg.refusalFallback });
  }

  if (!cfg.baseUrl) {
    throw new Error('llm.baseUrl fehlt — für LM Studio z.B. http://localhost:1234/v1');
  }
  return new OpenAiCompatibleClient({ model, baseUrl: cfg.baseUrl });
}
