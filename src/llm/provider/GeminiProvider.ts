import type { LLMProviderConfig } from "../../config/config.js";
import type { LLM } from "../LLM.js";
import type { LLMResult, LLMUsage } from "../../types/types.js";

type GeminiPart = {
  text?: string;
};

type GeminiCandidate = {
  content?: {
    parts?: GeminiPart[];
  };
};

type GeminiUsageMetadata = {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
};

type GeminiGenerateResponse = {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

export class GeminiProvider implements LLM {
  private readonly apiKey: string;
  private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta";

  constructor(private readonly config: LLMProviderConfig) {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;

    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set");
    }

    this.apiKey = apiKey;
  }

  async complete(prompt: string): Promise<LLMResult> {
    const response = await fetch(
      `${this.baseUrl}/models/${this.config.reasoningModel}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(this.buildRequestBody(prompt)),
      },
    );

    const json = (await response.json()) as GeminiGenerateResponse;

    if (!response.ok || json.error) {
      throw new Error(this.formatError(json, response.status));
    }

    return {
      text: this.extractText(json).trim(),
      usage: this.mapUsage(json.usageMetadata),
    };
  }

  async stream(
    prompt: string,
    onText: (text: string) => void,
  ): Promise<LLMResult> {
    const response = await fetch(
      `${this.baseUrl}/models/${this.config.generationModel}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(this.buildRequestBody(prompt)),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();

      throw new Error(
        `Gemini API error ${response.status}: ${errorText}`,
      );
    }

    if (!response.body) {
      throw new Error("Gemini API returned no response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let fullText = "";
    let finalUsage: LLMUsage | undefined;

    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        const data = this.parseSseData(event);

        if (!data || data === "[DONE]") {
          continue;
        }

        const chunk = JSON.parse(data) as GeminiGenerateResponse;

        if (chunk.error) {
          throw new Error(this.formatError(chunk));
        }

        const delta = this.extractText(chunk);

        if (delta.length > 0) {
          fullText += delta;
          onText(fullText);
        }

        if (chunk.usageMetadata) {
          finalUsage = this.mapUsage(chunk.usageMetadata);
        }
      }
    }

    return {
      text: fullText.trim(),
      usage: finalUsage,
    };
  }

  private buildRequestBody(prompt: string) {
    return {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: prompt,
            },
          ],
        },
      ],
    };
  }

  private extractText(response: GeminiGenerateResponse): string {
    return (
      response.candidates
        ?.flatMap((candidate) => candidate.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("") ?? ""
    );
  }

  private parseSseData(event: string): string | undefined {
    const lines = event.split("\n");

    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim());

    if (dataLines.length === 0) {
      return undefined;
    }

    return dataLines.join("\n");
  }

  private mapUsage(
    usage: GeminiUsageMetadata | null | undefined,
  ): LLMUsage | undefined {
    if (!usage) return undefined;

    return {
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      totalTokens: usage.totalTokenCount ?? 0,
      cachedTokens: usage.cachedContentTokenCount,
      reasoningTokens: usage.thoughtsTokenCount,
    };
  }

  private formatError(
    response: GeminiGenerateResponse,
    fallbackStatus?: number,
  ): string {
    const code = response.error?.code ?? fallbackStatus ?? "unknown";
    const status = response.error?.status ?? "UNKNOWN";
    const message = response.error?.message ?? "Unknown Gemini API error";

    return `Gemini API error ${code} ${status}: ${message}`;
  }
}
