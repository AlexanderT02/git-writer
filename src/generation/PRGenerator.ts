import ora from "ora";
import type { PRContext, PRGenerationResult } from "../types/types.js";
import type { AppConfig } from "../config/config.js";
import type { LLM } from "../llm/LLM.js";
import { DefaultPRPromptBuilder } from "../prompts/prPrompts.js";
import type { PRPromptBuilder } from "../prompts/promptBuilder.js";

export class PRGenerator {
  extraInstruction = "";

  constructor(
    private readonly ai: LLM,
    private readonly config: AppConfig,
    private readonly prompts: PRPromptBuilder = new DefaultPRPromptBuilder(),
  ) {}

  private isRateLimitError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;

    const candidate = error as {
      status?: number;
      statusCode?: number;
      code?: string | number;
      message?: string;
    };

    return (
      candidate.status === 429 ||
      candidate.statusCode === 429 ||
      candidate.code === 429 ||
      candidate.code === "rate_limit_exceeded" ||
      /429|rate limit/i.test(candidate.message || "")
    );
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
    options: {
      retries?: number;
      initialDelayMs?: number;
      maxDelayMs?: number;
    } = {},
  ): Promise<T> {
    const retries = options.retries ?? 3;
    const initialDelayMs = options.initialDelayMs ?? 1_000;
    const maxDelayMs = options.maxDelayMs ?? 8_000;

    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (!this.isRateLimitError(error) || attempt === retries) {
          throw error;
        }

        const delay = Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  buildReasoningPrompt(prContext: PRContext): string {
    return this.prompts.buildReasoningPrompt(
      {
        context: prContext,
        extraInstruction: this.extraInstruction,
      },
      this.config,
    );
  }

  buildMessagePrompt(reasoning: string): string {
    return this.prompts.buildMessagePrompt(
      {
        context: {} as PRContext,
        reasoning,
        extraInstruction: this.extraInstruction,
      },
      this.config,
    );
  }

  async generate(prContext: PRContext): Promise<PRGenerationResult> {
    const spinner = ora("Analyzing PR context...").start();

    let reasoningResult: Awaited<ReturnType<typeof this.ai.complete>>;
    let outputResult: Awaited<ReturnType<typeof this.ai.complete>>;

    try {
      reasoningResult = await this.withRetry(() =>
        this.ai.complete(this.buildReasoningPrompt(prContext)),
      );

      spinner.text = "Generating PR Markdown...";

      outputResult = await this.withRetry(() =>
        this.ai.complete(this.buildMessagePrompt(reasoningResult.text)),
      );
    } finally {
      spinner.stop();
    }

    const parsed = this.parsePROutput(outputResult.text);

    return {
      ...parsed,
      usage: {
        reasoning: reasoningResult.usage,
        generation: outputResult.usage,
        totalTokens:
        (reasoningResult.usage?.totalTokens ?? 0) +
        (outputResult.usage?.totalTokens ?? 0),
      },
    };
  }

  parsePROutput(output: string): { title: string; description: string } {
    const cleaned = this.cleanMarkdown(output);

    const titleBodyMatch = cleaned.match(
      /TITLE:\s*([\s\S]*?)\n\s*BODY:\s*([\s\S]*)/i,
    );

    if (titleBodyMatch) {
      return {
        title: this.cleanTitle(titleBodyMatch[1] ?? ""),
        description: this.cleanBody(titleBodyMatch[2] ?? ""),
      };
    }

    const headingMatch = cleaned.match(
      /#+\s*PR Title\s*\n([\s\S]*?)\n#+\s*PR Description\s*\n([\s\S]*)/i,
    );

    if (headingMatch) {
      return {
        title: this.cleanTitle(headingMatch[1] ?? ""),
        description: this.cleanBody(headingMatch[2] ?? ""),
      };
    }

    const lines = cleaned
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return {
      title: this.cleanTitle(lines[0] ?? "PR Update"),
      description: this.cleanBody(lines.slice(1).join("\n")),
    };
  }

  private cleanMarkdown(text: string): string {
    return text
      .replace(/```(?:markdown|md)?/gi, "")
      .replace(/```/g, "")
      .trim();
  }

  private cleanTitle(title: string): string {
    return (
      title
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ")
        .replace(/^[-*]\s*/, "")
        .replace(/^#+\s*/, "")
        .replace(/^PR Title:?\s*/i, "")
        .replace(/^TITLE:?\s*/i, "")
        .trim() || "PR Update"
    );
  }

  private cleanBody(body: string): string {
    return body
      .replace(/^BODY:\s*/i, "")
      .replace(/^#+\s*PR Description\s*/i, "")
      .replace(/^#+\s*PR Title\s*[\s\S]*?(?=^#+\s|$)/im, "")
      .trim();
  }
}
