import type { AppConfig } from "../config/config.js";
import type {
  CommitPromptBuilder,
  CommitPromptInput,
} from "./promptBuilder.js";

export class DefaultCommitPromptBuilder implements CommitPromptBuilder {
  buildReasoningPrompt(
    { files, context }: CommitPromptInput,
    config: AppConfig,
  ): string {
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
          .slice(0, config.commit.reasoningDiffPreviewLines)
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
    { files, context, reasoning, extraInstruction }: CommitPromptInput,
    config: AppConfig,
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
      extraInstruction && `User instruction: ${extraInstruction}`,
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
- Summary must be <= ${config.commit.summaryMaxLength} characters
- Summary must use imperative mood
- Summary must not end with a period
- Summary must describe the dominant change, not every detail
- Body should contain exactly ${config.commit.preferredBulletCount} bullets unless ${config.commit.maxBulletCount} are needed
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
}
