import ora from "ora";
import type { PRContext, PRGenerationResult } from "../types/types.js";
import type { AppConfig } from "../config/config.js";
import type { LLM } from "../llm/LLM.js";

export class PRGenerator {
  extraInstruction = "";

  constructor(
    private readonly ai: LLM,
    private readonly config: AppConfig,
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
    const sections = [
      `Branch: ${prContext.branch}${prContext.issue ? ` (${prContext.issue})` : ""}`,
      prContext.commits ? `Commits:\n${prContext.commits}` : "",
      prContext.diff
        ? `Diff preview (first ${this.config.commit.reasoningDiffPreviewLines} lines):\n${prContext.diff
          .split("\n")
          .slice(0, this.config.commit.reasoningDiffPreviewLines)
          .join("\n")}`
        : "",
      prContext.fileContexts ? `File contexts:\n${prContext.fileContexts}` : "",
      this.extraInstruction ? `User instruction: ${this.extraInstruction}` : "",
    ].filter(Boolean);

    return `You are an expert software engineer. Analyze the following Git context in detail:

- Identify the main purpose of the changes
- Summarize key modifications
- Point out potential risks, regressions, or breaking changes
- Provide reasoning behind each significant change

Present your output in structured plain text, clearly labeling each section:

${sections.join("\n\n")}`;
  }

  buildMessagePrompt(reasoning: string): string {
    return `Based on the analysis below, generate a concise GitHub pull request.

Return exactly this format:

TITLE:
<one concise PR title, max 15 words>

BODY:
## Summary
<1 short paragraph>

## Changes
- <key change>
- <key change>
- <key change>

## Risks
- <risk, breaking change, or "No major risks identified">

Rules:
- Do not add text before TITLE:
- Do not use "# PR Title"
- Do not use "# PR Description"
- Do not include the title in BODY
- Do not wrap the output in code fences
- Keep it short but complete
- Mention breaking changes only if clearly supported by the changes
- Do not invent tests, migrations, or behavior

Analysis:
${reasoning}`;
  }

  async generate(prContext: PRContext): Promise<PRGenerationResult> {
    const spinner = ora("Analyzing PR context...").start();

    let reasoning = "";
    let reasoningUsage: PRGenerationResult["usage"]["reasoning"];

    try {
      const reasoningResult = await this.withRetry(() =>
        this.ai.complete(this.buildReasoningPrompt(prContext)),
      );

      reasoning = reasoningResult.text;
      reasoningUsage = reasoningResult.usage;
    } catch {
      reasoning = "";
      reasoningUsage = undefined;
    }

    spinner.text = "Generating PR Markdown...";

    let output = "";
    let generationUsage: PRGenerationResult["usage"]["generation"];

    try {
      const outputResult = await this.withRetry(() =>
        this.ai.complete(this.buildMessagePrompt(reasoning)),
      );

      output = outputResult.text;
      generationUsage = outputResult.usage;
    } catch {
      output = "";
      generationUsage = undefined;
    }

    spinner.stop();

    const parsed = this.parsePROutput(output);

    return {
      ...parsed,
      usage: {
        reasoning: reasoningUsage,
        generation: generationUsage,
        totalTokens:
          (reasoningUsage?.totalTokens ?? 0) +
          (generationUsage?.totalTokens ?? 0),
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
