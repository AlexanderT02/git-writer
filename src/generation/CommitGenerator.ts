import ora from "ora";
import { UI } from "../ui/UI.js";
import type { AppConfig } from "../config/config.js";
import type { CommitContext } from "../types/types.js";
import type { LLM } from "../llm/LLM.js";
import { estimateLLMCall } from "../llm/tokenEstimate.js";

export class CommitGenerator {
  extraInstruction = "";

  constructor(
    private readonly ai: LLM,
    private readonly config: AppConfig,
  ) {}

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

    return `Write one Conventional Commit message using the analysis and staged context.

Analysis:
${reasoning || "NONE"}

Output exactly one commit message in this format:

<type>(<scope>): <summary>

- <bullet>
- <bullet>

Optional footer:
BREAKING CHANGE: <description>

Rules:
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
    return (message || "")
      .replace(/```[\s\S]*?\n/g, "")
      .replace(/```/g, "")
      .replace(/^plaintext\s*/i, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async generate(files: string, context: CommitContext): Promise<string> {
    const reasoningPrompt = this.buildReasoningPrompt(files, context);
    const reasoningEstimate = estimateLLMCall(reasoningPrompt, 700);

    UI.renderTokenEstimate(reasoningEstimate.totalTokens, "Analysis tokens");

    const spinner = ora("Analysing intent...").start();

    let reasoning = "";

    try {
      reasoning = await this.ai.complete(reasoningPrompt);
    } catch {
      reasoning = "";
    }

    const messagePrompt = this.buildMessagePrompt(files, context, reasoning);
    const messageEstimate = estimateLLMCall(messagePrompt, 350);

    const totalTokens =
      reasoningEstimate.totalTokens + messageEstimate.totalTokens;

    spinner.stop();

    UI.renderTokenEstimate(totalTokens);

    const streamSpinner = ora("Generating commit message...").start();

    const result = await this.ai.stream(messagePrompt, (text) => {
      streamSpinner.stop();
      UI.render(text, this.config);
    });

    streamSpinner.stop();

    return this.sanitizeCommitMessage(result);
  }
}
