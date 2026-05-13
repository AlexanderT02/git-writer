import ora from "ora";
import { UI } from "../ui/UI.js";
import type { AppConfig } from "../config/config.js";
import type { CommitContext, CommitGenerationResult } from "../types/types.js";
import type { LLM } from "../llm/LLM.js";
import {
  DefaultCommitPromptBuilder,
} from "../prompts/commitPrompts.js";
import type { CommitPromptBuilder } from "../prompts/promptBuilder.js";

export class CommitGenerator {
  extraInstruction = "";

  constructor(
    private readonly ai: LLM,
    private readonly config: AppConfig,
    private readonly prompts: CommitPromptBuilder = new DefaultCommitPromptBuilder(),
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

  buildReasoningPrompt(files: string, context: CommitContext): string {
    return this.prompts.buildReasoningPrompt(
      {
        files,
        context,
        extraInstruction: this.extraInstruction,
      },
      this.config,
    );
  }

  buildMessagePrompt(
    files: string,
    context: CommitContext,
    reasoning: string,
  ): string {
    return this.prompts.buildMessagePrompt(
      {
        files,
        context,
        reasoning,
        extraInstruction: this.extraInstruction,
      },
      this.config,
    );
  }

  sanitizeCommitMessage(message: string): string {
    const cleaned = (message || "")
      .replace(/^```(?:text|txt|md|markdown|json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .replace(/^plaintext\s*/i, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const unwrapped = this.unwrapJsonCommitMessage(cleaned);

    return unwrapped
      .replace(/^["']|["']$/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private unwrapJsonCommitMessage(message: string): string {
    const candidates = [
      message,
      this.extractJsonArray(message),
      this.extractJsonObject(message),
    ].filter((value): value is string => Boolean(value));

    for (const candidateText of candidates) {
      try {
        const parsed = JSON.parse(candidateText);

        if (Array.isArray(parsed)) {
          const textItems = parsed.filter(
            (item): item is string => typeof item === "string",
          );

          if (textItems.length > 0) {
            return textItems.join("\n\n").trim();
          }
        }

        if (typeof parsed === "string") {
          return parsed.trim();
        }

        if (parsed && typeof parsed === "object") {
          const candidate = parsed as {
            message?: unknown;
            commitMessage?: unknown;
            text?: unknown;
          };

          if (typeof candidate.message === "string") {
            return candidate.message.trim();
          }

          if (typeof candidate.commitMessage === "string") {
            return candidate.commitMessage.trim();
          }

          if (typeof candidate.text === "string") {
            return candidate.text.trim();
          }
        }
      } catch {
      // Try next candidate.
      }
    }

    return message;
  }

  private extractJsonArray(text: string): string | undefined {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");

    if (start === -1 || end === -1 || end <= start) {
      return undefined;
    }

    return text.slice(start, end + 1);
  }

  private extractJsonObject(text: string): string | undefined {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      return undefined;
    }

    return text.slice(start, end + 1);
  }

  async generate(
    files: string,
    context: CommitContext,
    options: { render?: boolean } = {},
  ): Promise<CommitGenerationResult> {
    const render = options.render ?? true;

    const reasoningPrompt = this.buildReasoningPrompt(files, context);

    const spinner = ora("Analysing intent...").start();

    let reasoningResult: Awaited<ReturnType<typeof this.ai.complete>>;

    try {
      reasoningResult = await this.withRetry(() =>
        this.ai.complete(reasoningPrompt),
      );
    } finally {
      spinner.stop();
    }

    const reasoning = reasoningResult.text;
    const reasoningUsage = reasoningResult.usage;

    const messagePrompt = this.buildMessagePrompt(files, context, reasoning);

    const streamSpinner = ora("Generating commit message...").start();

    let result: Awaited<ReturnType<typeof this.ai.complete | typeof this.ai.stream>>;
    let streamedText = "";

    try {
      if (render) {
        const renderer = UI.createCommitMessageLiveRenderer(this.config);

        result = await this.withRetry(() =>
          this.ai.stream(messagePrompt, (text) => {
            streamSpinner.stop();

            if (!text.trim()) return;

            if (text.startsWith(streamedText)) {
              // Provider sends full snapshot.
              streamedText = text;
            } else {
              // Provider sends delta.
              streamedText += text;
            }

            const sanitized = this.sanitizeCommitMessage(streamedText);

            if (sanitized.trim()) {
              renderer.render(sanitized);
            }
          }),
        );

        const message = this.sanitizeCommitMessage(result.text || streamedText);

        renderer.end(message);

        return {
          message,
          usage: {
            reasoning: reasoningUsage,
            generation: result.usage,
            totalTokens:
              (reasoningUsage?.totalTokens ?? 0) +
              (result.usage?.totalTokens ?? 0),
          },
        };
      }

      result = await this.withRetry(() => this.ai.complete(messagePrompt));
    } finally {
      streamSpinner.stop();
    }

    const message = this.sanitizeCommitMessage(result.text || streamedText);

    return {
      message,
      usage: {
        reasoning: reasoningUsage,
        generation: result.usage,
        totalTokens:
          (reasoningUsage?.totalTokens ?? 0) +
          (result.usage?.totalTokens ?? 0),
      },
    };
  }
}
