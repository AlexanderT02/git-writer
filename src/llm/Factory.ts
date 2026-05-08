import type {
  AppConfig,
  LLMProviderConfig,
  LLMProviderName,
} from "../config/config.js";
import type { LLM } from "./LLM.js";
import { OllamaProvider } from "./provider/OllamaProvider.js";
import { OpenAIProvider } from "./provider/OpenAIProvider.js";
import { GeminiProvider } from "./provider/GeminiProvider.js";

type LLMProviderConstructor = new (config: LLMProviderConfig) => LLM;

const providers = {
  openai: OpenAIProvider,
  ollama: OllamaProvider,
  gemini: GeminiProvider,
} satisfies Record<LLMProviderName, LLMProviderConstructor>;

export function createLLMProvider(
  appConfig: AppConfig,
  providerOverride?: LLMProviderName,
): LLM {
  const providerName = providerOverride ?? appConfig.llm.defaultProvider;
  const modelConfig = appConfig.llm.providers[providerName];

  if (!modelConfig) {
    throw new Error(`Missing config for LLM provider: ${providerName}`);
  }

  const Provider = providers[providerName];

  if (!Provider) {
    throw new Error(`Unsupported LLM provider: ${providerName}`);
  }

  return new Provider({
    provider: providerName,
    ...modelConfig,
  });
}
