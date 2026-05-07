import type { LLMResult } from "../types/types.js";

export interface LLM {
  complete(prompt: string): Promise<LLMResult>;

  stream(
    prompt: string,
    onText: (text: string) => void,
  ): Promise<LLMResult>;
}
