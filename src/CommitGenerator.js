import ora from "ora";
import { UI } from "./ui.js";

export class CommitGenerator {
  constructor(ai) {
    this.ai = ai;
    this.extraInstruction = "";
  }

  // ── reasoning prompt (intent extraction) ──────────────────────────
  buildReasoningPrompt(files, context) {
    const {
      branch,
      issue,
      fileHints,
      changedSymbols,
      stagedFileSummaries,
      stagedStats,
      recentStyleHints,
      fullFileContext,
      _diff,
    } = context;

    // Sections are only injected when non-empty — no blank lines or
    // orphaned labels wasting tokens.
    const sections = [
      `Branch: ${branch}${issue ? ` (${issue})` : ""}`,
      fileHints && `Technologies: ${fileHints}`,
      stagedStats && `Stats: ${stagedStats}`,
      recentStyleHints,
      stagedFileSummaries && `Staged files:\n${stagedFileSummaries}`,
      !stagedFileSummaries && `Staged files:\n${files}`,
      changedSymbols && `Changed symbols:\n${changedSymbols}`,
      fullFileContext
        ? `Full file context (before → after):\n${fullFileContext}`
        : `Diff sketch:\n${_diff.split("\n").slice(0, 80).join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    return `Analyse staged git changes and identify the dominant commit intent.

Return exactly this format:

TYPE: <feat|fix|refactor|perf|test|docs|chore|ci|build|revert>
SCOPE: <single scope or NONE>
INTENT: <one sentence>
BULLETS:
- <specific change>
- <specific change>
- <specific change>

Rules:
- Pick the single dominant concern
- Use a narrow scope if clear, otherwise NONE
- Bullets must be concrete
- No code fences
- No markdown headings

${sections}`;
  }

  // ── message prompt (final commit message) ─────────────────────────
  buildMessagePrompt(files, context, reasoning) {
    const {
      branch,
      issue,
      fileHints,
      changedSymbols,
      recentCommits,
      recentStyleHints,
      stagedFileSummaries,
      stagedStats,
      fullFileContext,
      _diff,
    } = context;

    const breakingHint =
      _diff.includes("BREAKING") || _diff.includes("breaking change")
        ? "Only include BREAKING CHANGE if a public API, schema, interface, or contract truly changed."
        : "";

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
      fullFileContext
        ? `Full file context (before → after):\n${fullFileContext}`
        : `Diff:\n${_diff}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    return `Write a Conventional Commit message from this analysis:

${reasoning}

Output format:
<type>(<scope>): <summary>

- <bullet>
- <bullet>

Optional:
BREAKING CHANGE: <description>

Rules:
- Summary max 72 chars
- Imperative mood
- No trailing period
- Scope only if helpful
- Prefer 2 bullets, max 3
- Bullets must be concrete and visible in staged changes
- Do not invent behavior
- Do not use vague words like: update, improve, change, misc, cleanup, various
- Prefer verbs like: add, remove, extract, rename, validate, wire, split, replace, handle
- Plain text only
${breakingHint}

${sections}`;
  }

  sanitizeCommitMessage(message) {
    return (message || "")
      .replace(/```[\s\S]*?\n/g, "")
      .replace(/```/g, "")
      .replace(/^plaintext\s*/i, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async generate(files, context = {}) {
    const spinner = ora("Analysing intent...").start();

    let reasoning = "";
    try {
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
        spinner.stop();
        UI.render(text);
      },
    );

    spinner.stop();
    return this.sanitizeCommitMessage(result);
  }
}