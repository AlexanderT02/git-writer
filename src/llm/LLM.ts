import type { LLMProviderName } from "../config/Config.js";
import type { LLMResult } from "../types/Types.js";
import { withLLMErrorHandling } from "./WithLLMErrorHandling.js";

export interface LLM {
  complete(prompt: string): Promise<LLMResult>;

  stream(
    prompt: string,
    onText: (text: string) => void,
  ): Promise<LLMResult>;
}

export abstract class BaseLLMProvider implements LLM {
  protected abstract readonly provider: LLMProviderName;

  async complete(prompt: string): Promise<LLMResult> {
    return withLLMErrorHandling(this.provider, () => {
      return this.doComplete(prompt);
    });
  }

  async stream(
    prompt: string,
    onText: (text: string) => void,
  ): Promise<LLMResult> {
    return withLLMErrorHandling(this.provider, () => {
      return this.doStream(prompt, onText);
    });
  }

  protected abstract doComplete(prompt: string): Promise<LLMResult>;

  protected abstract doStream(
    prompt: string,
    onText: (text: string) => void,
  ): Promise<LLMResult>;
}
