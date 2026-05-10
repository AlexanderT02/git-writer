import OpenAI from "openai";
import type { LLMProviderConfig, LLMProviderName } from "../../config/config.js";
import type { LLMResult, LLMUsage } from "../../types/types.js";
import { BaseLLMProvider } from "../LLM.js";
import { requireProviderEnv } from "../withLLMErrorHandling.js";

export class OpenAIProvider extends BaseLLMProvider {
  protected readonly provider: LLMProviderName = "openai";
  private readonly client: OpenAI;

  constructor(private readonly config: LLMProviderConfig) {
    super();

    this.client = new OpenAI({
      apiKey: requireProviderEnv("openai", "OPENAI_API_KEY"),
    });
  }

  protected async doComplete(prompt: string): Promise<LLMResult> {
    const response = await this.client.responses.create({
      model: this.config.reasoningModel,
      input: prompt,
    });

    return {
      text: response.output_text.trim(),
      usage: this.mapUsage(response.usage),
    };
  }

  protected async doStream(
    prompt: string,
    onText: (text: string) => void,
  ): Promise<LLMResult> {
    const stream = await this.client.responses.stream({
      model: this.config.generationModel,
      input: prompt,
    });

    let fullText = "";

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        fullText += event.delta;
        onText(fullText);
      }
    }

    const finalResponse = await stream.finalResponse();

    return {
      text: fullText.trim(),
      usage: this.mapUsage(finalResponse.usage),
    };
  }

  private mapUsage(
    usage:
      | {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_tokens_details?: {
          cached_tokens?: number;
        };
        output_tokens_details?: {
          reasoning_tokens?: number;
        };
      }
      | null
      | undefined,
  ): LLMUsage | undefined {
    if (!usage) return undefined;

    return {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
      cachedTokens: usage.input_tokens_details?.cached_tokens,
      reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
    };
  }
}
