import clipboard from "clipboardy";

import { config } from "../config/config.js";
import { CommitGenerator } from "../generation/CommitGenerator.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { GitService } from "../git/GitService.js";
import { createLLM } from "../llm/index.js";
import { StagingService } from "../staging/StagingService.js";
import { UI } from "../ui/UI.js";
import type { LLM } from "../llm/LLM.js";
import type { PRContext } from "../types/types.js";
import { PRGenerator } from "../generation/PRGenerator.js";

export class App {
  private readonly git: GitService;
  private readonly ai: LLM;
  private readonly staging: StagingService;
  private readonly context: ContextBuilder;
  private readonly commitGenerator: CommitGenerator;
  private readonly issueRefs: string[] | null;
  private readonly fastMode: boolean;

  constructor(fastMode = false) {
    this.fastMode = fastMode;
    this.git = new GitService(config);
    this.ai = createLLM(config);
    this.staging = new StagingService(this.git, config);
    this.context = new ContextBuilder(this.git, config);
    this.commitGenerator = new CommitGenerator(this.ai, config);
    this.issueRefs = this.parseIssueRefs();
  }

  parseIssueRefs(): string[] | null {
    const args = process.argv.slice(2);
    const nums = args.filter((arg) => /^\d+$/.test(arg));

    if (!nums.length) return null;

    return nums.map((num) => `#${num}`);
  }

  appendIssueRefs(message: string): string {
    if (!this.issueRefs) return message;

    return `${message}\n\nrefs ${this.issueRefs.join(", ")}`;
  }

  async runCommitInteractive(): Promise<void> {
    if (this.fastMode) {
      return this.runCommitFast();
    }

    while (true) {
      await this.staging.ensureStaged();

      const files = this.git.getStagedFiles();
      const ctx = this.context.build(files);
      let message = await this.commitGenerator.generate(files, ctx);

      while (true) {
        UI.render(message, config);

        const action = await UI.actionMenu(config);

        if (action === "commit") {
          this.commit(message);
        }

        if (action === "regen") {
          this.commitGenerator.extraInstruction = "";
          message = await this.commitGenerator.generate(files, ctx);
          continue;
        }

        if (action === "refine") {
          const text = await UI.refineInput(config);
          this.commitGenerator.extraInstruction = text;
          message = await this.commitGenerator.generate(files, ctx);
          continue;
        }

        if (action === "edit") {
          message = await UI.editMessage(message, config);
          continue;
        }

        if (action === "copy") {
          await clipboard.write(message);
          UI.renderCopied();
          continue;
        }

        UI.renderCancelled();
        process.exit(0);
      }
    }
  }

  private async runCommitFast(): Promise<void> {
    this.git.add(["."]);

    const files = this.git.getStagedFiles();

    if (!files.trim()) {
      UI.renderNothingToCommit();
      process.exit(0);
    }

    const ctx = this.context.build(files);
    const message = await this.commitGenerator.generate(files, ctx);

    this.commit(message);
  }

  private commit(message: string): never {
    const finalMessage = this.appendIssueRefs(message);

    this.git.commit(finalMessage);
    UI.renderCommitCreated(this.git.getLastCommitSummary());

    process.exit(0);
  }

  buildPRContext(baseBranch: string = "origin/main"): PRContext {
    return this.context.buildPRContext(baseBranch);
  }

  async runPRInteractive(baseBranch?: string): Promise<void> {
    const selectedBaseBranch =
      baseBranch ??
    await UI.selectBranch(
      this.git.getBranchPRSummaries(),
      "Select base branch for PR:",
    );

    const prContext = this.buildPRContext(selectedBaseBranch);
    const prGenerator = new PRGenerator(this.ai, config);
    const { title, description } = await prGenerator.generate(prContext);

    while (true) {
      UI.renderPRPreview(selectedBaseBranch, title, description);

      const action = await UI.prActionMenu();

      if (action === "copy") {
        await clipboard.write(`${title}\n\n${description}`);
        UI.renderCopied("Copied PR to clipboard");
        process.exit(0);
      }

      if (action === "create") {
        if (!this.git.hasGitHubCli()) {
          throw new Error(
            "GitHub CLI is not installed or not available in PATH. Install it and run: gh auth login",
          );
        }

        const url = this.git.createPullRequestViaGithubCli(
          selectedBaseBranch,
          title,
          description,
        );

        UI.renderPRCreated(url);
        process.exit(0);
      }

      UI.renderCancelled();
      process.exit(0);
    }
  }
}
