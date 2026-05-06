import type { LLM } from "./LLM.js";
import { OpenAIProvider } from "./OpenAIProvider.js";
// import { OllamaProvider } from "./OllamaProvider.js";

export function createLLM(): LLM {
  return new OpenAIProvider();

  // To switch provider manually:
  // return new OllamaProvider();
}