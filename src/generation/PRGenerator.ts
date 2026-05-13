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

    return `You are an expert software engineer preparing a GitHub pull request for review.

Analyze the provided Git context carefully and produce structured notes for a PR generator.

Focus only on facts supported by the commits, diff preview, branch name, issue context, and file contexts.

Your analysis must include:

## Intent
- What is the main purpose of this PR?
- What user/developer problem does it solve?

## Key Changes
- List the most important implementation changes.
- Be specific about changed areas, modules, files, config, CLI behavior, or tests when visible.

## Behavior Changes
- Describe visible behavior changes for users or developers.
- If no clear behavior change is visible, say so.

## Testing Evidence
- Mention tests only if tests are visible in the commits, diff preview, or file contexts.
- If test files were added or changed, describe what they appear to cover.
- If a test command or test result is explicitly shown, mention it.
- If no testing evidence is visible, say: "No testing evidence found."
- Do not infer that tests were run unless the context proves it.

## Risks
- Identify concrete risks, regressions, edge cases, or migration concerns.
- Avoid vague risks unless no specific risk can be inferred.
- If risk appears low, explain why briefly.

## Review Notes
- Mention anything reviewers should pay attention to.
- Include naming, casing, API, config, or UX concerns if visible.

Rules:
- Do not invent files, tests, commands, issues, or behavior.
- Do not claim tests passed unless a test result is explicitly provided.
- Do not claim performance, security, or compatibility improvements unless directly supported.
- Prefer concrete technical language over marketing language.
- Keep the analysis concise but detailed enough to generate a useful PR.

Git context:

${sections.join("\n\n")}`;
  }

  buildMessagePrompt(reasoning: string): string {
    return `Based only on the analysis below, generate a concise GitHub pull request title and body.

Return exactly this format:

TITLE:
<one concise, specific PR title, max 15 words>

BODY:
## Summary
<1 short paragraph describing the purpose and outcome of the PR>

## Changes
- <specific implementation change>
- <specific implementation change>
- <specific implementation change>

<include this section only if tests are visible in the analysis>
## Testing
- <test file, test coverage, test command, or test result supported by the analysis>

## Risks
- <specific risk, edge case, breaking change, or "Low risk; changes are isolated">

Rules:
- Do not add text before TITLE:
- Do not use "# PR Title"
- Do not use "# PR Description"
- Do not include the title inside BODY
- Do not wrap the output in code fences
- Keep the PR body useful for a reviewer, not generic
- Use concrete nouns from the analysis: modules, files, commands, config names, or behaviors
- Avoid phrases like "This pull request introduces" unless it is the clearest wording
- Do not invent tests, test commands, migrations, benchmarks, issues, or breaking changes
- Include ## Testing only when the analysis shows test files, test changes, test commands, or test results
- If tests were added or changed but no command was run, mention only the added or changed tests; do not say tests passed
- If no testing evidence exists, omit ## Testing entirely
- Mention breaking changes only if clearly supported
- Prefer 2-4 bullets in Changes
- Prefer 1-3 bullets in Risks
- Keep the title action-oriented

Analysis:
${reasoning}`;
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
