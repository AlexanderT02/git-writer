import type { AppConfig, LLMProviderName } from "../config/config.js";
import type { LLM } from "./LLM.js";
import { OllamaProvider } from "./provider/OllamaProvider.js";
import { OpenAIProvider } from "./provider/OpenAIProvider.js";

type LLMProviderConstructor = new (config: AppConfig) => LLM;

const providers = {
  openai: OpenAIProvider,
  ollama: OllamaProvider,
} satisfies Record<LLMProviderName, LLMProviderConstructor>;

export function createLLM(config: AppConfig): LLM {
  const Provider = providers[config.llm.provider];

  if (!Provider) {
    throw new Error(`Unsupported LLM provider: ${config.llm.provider}`);
  }

  return new Provider(config);
}
