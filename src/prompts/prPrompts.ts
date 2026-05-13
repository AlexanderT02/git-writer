import type { AppConfig } from "../config/config.js";
import type { PRPromptBuilder, PRPromptInput } from "./promptBuilder.js";

export class DefaultPRPromptBuilder implements PRPromptBuilder {
  buildReasoningPrompt(
    { context, extraInstruction }: PRPromptInput,
    config: AppConfig,
  ): string {
    const sections = [
      `Branch: ${context.branch}${context.issue ? ` (${context.issue})` : ""}`,
      context.commits ? `Commits:\n${context.commits}` : "",
      context.diff
        ? `Diff preview (first ${config.commit.reasoningDiffPreviewLines} lines):\n${context.diff
          .split("\n")
          .slice(0, config.commit.reasoningDiffPreviewLines)
          .join("\n")}`
        : "",
      context.fileContexts ? `File contexts:\n${context.fileContexts}` : "",
      extraInstruction ? `User instruction: ${extraInstruction}` : "",
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

  buildMessagePrompt({ reasoning }: PRPromptInput): string {
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
${reasoning || "NONE"}`;
  }
}
