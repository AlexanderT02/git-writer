import ora from "ora";
import { UI } from "../ui/UI.js";
import type { PRContext } from "../types/types.js";
import type { AppConfig } from "../config/config.js";
import type { LLM } from "../llm/LLM.js";

export class PRGenerator {
  extraInstruction = "";

  constructor(
    private readonly ai: LLM,
    private readonly config: AppConfig,
  ) {}

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
    return `Based on the analysis below, generate a professional PR title and description in Markdown.

Requirements:

### PR Title
- One concise sentence (max 15 words) summarizing the main purpose

### PR Description
- Short paragraph explaining the purpose of the PR
- Bullet list of key changes
- Reasoning for changes
- Highlight potential risks or breaking changes
- Use clear Markdown headings and bullets
- Do not use code fences; only plain text inside Markdown

Analysis:
${reasoning}`;
  }

  async generate(prContext: PRContext): Promise<{ title: string; description: string }> {
    const spinner = ora("Analyzing PR context...").start();
    let reasoning = "";

    try {
      reasoning = await this.ai.complete(this.buildReasoningPrompt(prContext));
    } catch {
      reasoning = "";
    }

    spinner.text = "Generating PR Markdown...";
    let output = "";

    try {
      output = await this.ai.complete(this.buildMessagePrompt(reasoning));
    } catch {
      output = "";
    }

    spinner.stop();
    UI.render(output, this.config);

    const lines = output.split("\n").filter(Boolean);
    const titleIndex = lines.findIndex((line) => line.startsWith("### PR Title"));
    const descIndex = lines.findIndex((line) => line.startsWith("### PR Description"));

    const title = titleIndex !== -1 && descIndex !== -1
      ? lines.slice(titleIndex + 1, descIndex).join(" ").trim()
      : "PR Update";

    const description = descIndex !== -1
      ? lines.slice(descIndex + 1).join("\n").trim()
      : lines.join("\n").trim();

    return { title, description };
  }
}
