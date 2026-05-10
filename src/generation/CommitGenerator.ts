import ora from "ora";
import { UI } from "../ui/UI.js";
import type { AppConfig } from "../config/config.js";
import type { CommitContext, CommitGenerationResult } from "../types/types.js";
import type { LLM } from "../llm/LLM.js";

export class CommitGenerator {
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

  buildReasoningPrompt(files: string, context: CommitContext): string {
    const {
      branch,
      issue,
      changedSymbols,
      stagedFileSummaries,
      stagedStats,
      recentStyleHints,
      fileContext,
      _diff,
    } = context;

    const sections = [
      `Branch: ${branch}${issue ? ` (${issue})` : ""}`,
      stagedStats && `Stats: ${stagedStats}`,
      recentStyleHints,
      stagedFileSummaries && `Staged files:\n${stagedFileSummaries}`,
      !stagedFileSummaries && `Staged files:\n${files}`,
      changedSymbols && `Changed symbols:\n${changedSymbols}`,
      fileContext
        ? `File context:\n${fileContext}`
        : `Diff sketch:\n${(_diff || "")
          .split("\n")
          .slice(0, this.config.commit.reasoningDiffPreviewLines)
          .join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    return `Analyze staged git changes and extract the commit intent.

Return exactly this format:

TYPE: <feat|fix|refactor|perf|test|docs|chore|ci|build|revert>
SCOPE: <single lowercase scope or NONE>
INTENT: <one sentence describing the main user-visible or developer-facing effect>
WHY: <one sentence explaining why this change exists, or NONE>
RISK: <low|medium|high>
BULLETS:
- <specific changed behavior, structure, or file responsibility>
- <specific changed behavior, structure, or file responsibility>
- <specific changed behavior, structure, or file responsibility>

Classification guide:
- feat: new user-visible or developer-facing capability
- fix: bug fix or incorrect behavior corrected
- refactor: code structure change without behavior change
- perf: measurable or intentional performance improvement
- test: test-only changes
- docs: documentation-only changes
- chore: tooling, maintenance, formatting, dependency, or config work
- ci: CI pipeline or workflow changes
- build: build system, packaging, or release configuration
- revert: reverts a previous commit

Rules:
- Pick exactly one dominant type
- Use feat or fix only when behavior changes
- Use refactor when behavior is preserved
- Use a narrow lowercase scope if obvious from files or symbols, otherwise NONE
- Do not use broad scopes like app, code, files, changes, misc
- Bullets must be concrete and traceable to staged changes
- Do not mention unstaged, untracked, or inferred changes
- No code fences
- No markdown headings

${sections}`;
  }

  buildMessagePrompt(
    files: string,
    context: CommitContext,
    reasoning: string,
  ): string {
    const {
      branch,
      issue,
      changedSymbols,
      recentCommits,
      recentStyleHints,
      stagedFileSummaries,
      stagedStats,
      fileContext,
      _diff,
    } = context;

    const diff = _diff || "";

    const breakingHint = /breaking change|BREAKING/i.test(diff)
      ? "The diff mentions breaking changes. Include BREAKING CHANGE only if a public API, schema, interface, or contract truly changed."
      : "";

    const sections = [
      `Branch: ${branch}${issue ? ` (${issue})` : ""}`,
      stagedStats && `Stats: ${stagedStats}`,
      recentStyleHints,
      recentCommits && `Recent commits:\n${recentCommits}`,
      stagedFileSummaries && `Staged files:\n${stagedFileSummaries}`,
      !stagedFileSummaries && `Staged files:\n${files}`,
      changedSymbols && `Changed symbols:\n${changedSymbols}`,
      this.extraInstruction && `User instruction: ${this.extraInstruction}`,
      fileContext ? `File context:\n${fileContext}` : `Diff:\n${diff}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    return `You are now in COMMIT MESSAGE MODE.

      Write exactly one raw Git commit message using the analysis and staged context.

      The output must be plain commit-message text only.
      Do not output JSON.
      Do not output an array.
      Do not output an object.
      Do not wrap the message in quotes.
      Do not add explanations before or after the commit message.

      Analysis:
      ${reasoning || "NONE"}

      Output exactly one commit message in this format:

      <type>(<scope>): <summary>

      - <bullet>
      - <bullet>

      Optional footer:
      BREAKING CHANGE: <description>

      Hard output rules:
      - Output only the raw commit message
      - The first character of the response must be a lowercase conventional commit type letter
      - The first line must start with one of: feat, fix, refactor, perf, test, docs, chore, ci, build, revert
      - The first line must match either "<type>: <summary>" or "<type>(<scope>): <summary>"
      - Do not output JSON
      - Do not output an array like ["feat: ..."]
      - Do not output an object like {"message":"feat: ..."}
      - Do not wrap the commit message in quotes
      - Do not use markdown fences
      - Do not add any text before or after the commit message

      Commit rules:
      - Use the TYPE and SCOPE from the analysis unless clearly contradicted by staged context
      - Omit "(<scope>)" when SCOPE is NONE
      - Summary must be <= ${this.config.commit.summaryMaxLength} characters
      - Summary must use imperative mood
      - Summary must not end with a period
      - Summary must describe the dominant change, not every detail
      - Body should contain exactly ${this.config.commit.preferredBulletCount} bullets unless ${this.config.commit.maxBulletCount} are needed
      - Bullets must explain concrete changes visible in staged files
      - Bullets must not repeat the summary
      - Bullets must not mention file names unless the file name is important to understanding the change
      - Do not invent behavior, motivation, tests, migration steps, or performance claims
      - Do not use vague words: update, improve, change, misc, cleanup, various
      - Prefer precise verbs: add, remove, extract, rename, validate, wire, split, replace, handle, guard, derive
      - Plain text only
      - No markdown headings
      - No code fences

      Invalid outputs:
      ["feat: add login"]
      {"message":"feat: add login"}
      \`\`\`text
      feat: add login
      \`\`\`

      Valid outputs start directly with:
      feat:
      fix:
      refactor:
      perf:
      test:
      docs:
      chore:
      ci:
      build:
      revert:

      Breaking change rules:
      - Include BREAKING CHANGE only if a public API, schema, CLI contract, config contract, database shape, or exported interface changed incompatibly
      - Do not include BREAKING CHANGE for internal refactors, UI copy, formatting, or private helper changes
      ${breakingHint}

      Bad summaries:
      - update files
      - improve staging
      - change logic
      - cleanup code
      - refactor stuff

      Good summaries:
      - add tree-based staged file selection
      - guard commit context against empty diffs
      - split prompt generation into intent and message passes
      - handle renamed staged files in context builder

      ${sections}`;
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
  ): Promise<CommitGenerationResult> {
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
    const renderer = UI.createCommitMessageLiveRenderer(this.config);

    let streamedText = "";
    let result: Awaited<ReturnType<typeof this.ai.stream>>;

    try {
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
    } finally {
      streamSpinner.stop();
    }

    const message = this.sanitizeCommitMessage(result.text || streamedText);

    renderer.end(message);

    return {
      message: this.sanitizeCommitMessage(result.text),
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
