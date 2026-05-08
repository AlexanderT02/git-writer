import type { LLMProviderConfig } from "../../config/config.js";
import type { LLMResult, LLMUsage } from "../../types/types.js";
import type { LLM } from "../LLM.js";

type OllamaGenerateResponse = {
  response?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

export class OllamaProvider implements LLM {
  constructor(private readonly config: LLMProviderConfig) {}

  async complete(prompt: string): Promise<LLMResult> {
    const response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.reasoningModel,
        prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.statusText}`);
    }

    const data = (await response.json()) as OllamaGenerateResponse;

    return {
      text: (data.response ?? "").trim(),
      usage: this.mapUsage(data),
    };
  }

  async stream(
    prompt: string,
    onText: (text: string) => void,
  ): Promise<LLMResult> {
    /**
     * Keep current behavior:
     * use non-streaming generate, then render once.
     */
    const result = await this.completeWithModel(
      this.config.generationModel,
      prompt,
    );

    onText(result.text);

    return result;
  }

  private async completeWithModel(
    model: string,
    prompt: string,
  ): Promise<LLMResult> {
    const response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.statusText}`);
    }

    const data = (await response.json()) as OllamaGenerateResponse;

    return {
      text: (data.response ?? "").trim(),
      usage: this.mapUsage(data),
    };
  }

  private mapUsage(data: OllamaGenerateResponse): LLMUsage | undefined {
    const inputTokens = data.prompt_eval_count ?? 0;
    const outputTokens = data.eval_count ?? 0;
    const totalTokens = inputTokens + outputTokens;

    if (!inputTokens && !outputTokens) {
      return undefined;
    }

    return {
      inputTokens,
      outputTokens,
      totalTokens,
    };
  }
}
