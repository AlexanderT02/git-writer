import type { AppConfig } from "../config/config.js";
import type { LLM } from "./LLM.js";
import { OllamaProvider } from "./OllamaProvider.js";
import { OpenAIProvider } from "./OpenAIProvider.js";

export function createLLM(config: AppConfig): LLM {
  switch (config.llm.provider) {
    case "openai":
      return new OpenAIProvider(config);

    case "ollama":
      return new OllamaProvider(config);

    default:
      throw new Error(`Unsupported LLM provider: ${config.llm.provider}`);
  }
}