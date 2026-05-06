import ora from "ora";
import { UI } from "./UI.js";
import type { AIClient, CommitContext } from "./types.js";

export class CommitGenerator {
  extraInstruction = "";

  constructor(private readonly ai: AIClient) {}

  buildReasoningPrompt(files: string, context: CommitContext): string {
    const {
      branch,
      issue,
      fileHints,
      changedSymbols,
      stagedFileSummaries,
      stagedStats,
      recentStyleHints,
      fileContext,
      _diff,
    } = context;

    // Keep the reasoning prompt focused on intent, not final wording.
    const sections = [
      `Branch: ${branch}${issue ? ` (${issue})` : ""}`,
      fileHints && `Technologies: ${fileHints}`,
      stagedStats && `Stats: ${stagedStats}`,
      recentStyleHints,
      stagedFileSummaries && `Staged files:\n${stagedFileSummaries}`,
      !stagedFileSummaries && `Staged files:\n${files}`,
      changedSymbols && `Changed symbols:\n${changedSymbols}`,
      fileContext
        ? `File context:\n${fileContext}`
        : `Diff sketch:\n${(_diff || "").split("\n").slice(0, 80).join("\n")}`,
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
      fileHints,
      changedSymbols,
      recentCommits,
      recentStyleHints,
      stagedFileSummaries,
      stagedStats,
      fileContext,
      _diff,
    } = context;

    const diff = _diff || "";

    // Mention breaking changes only when the diff gives a real signal.
    const breakingHint = /breaking change|BREAKING/i.test(diff)
      ? "The diff mentions breaking changes. Include BREAKING CHANGE only if a public API, schema, interface, or contract truly changed."
      : "";

    // The final prompt adds style examples and optional user guidance.
    const sections = [
      `Branch: ${branch}${issue ? ` (${issue})` : ""}`,
      fileHints && `Technologies: ${fileHints}`,
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
- Summary must be <= 72 characters
- Summary must use imperative mood
- Summary must not end with a period
- Summary must describe the dominant change, not every detail
- Body should contain exactly 2 bullets unless 3 are needed
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
    const spinner = ora("Analysing intent...").start();
    let reasoning = "";

    try {
      // First pass extracts the dominant intent.
      // If this fails, the final prompt can still work from raw context.
      reasoning = await this.ai.complete(
        this.buildReasoningPrompt(files, context),
      );
    } catch {
      reasoning = "";
    }

    spinner.text = "Generating commit message...";

    const result = await this.ai.streamCompletion(
      this.buildMessagePrompt(files, context, reasoning),
      (text) => {
        // Stop the spinner before rendering streamed output.
        spinner.stop();
        UI.render(text);
      },
    );

    spinner.stop();

    return this.sanitizeCommitMessage(result);
  }
}