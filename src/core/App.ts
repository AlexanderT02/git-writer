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
import { GitPRService } from "../git/GitPRService.js";
import { GitHubCLIService } from "../git/GitHubCliService.js";
import {
  estimateCommitTokens,
  estimatePRTokens,
} from "../llm/generationEstimate.js";

export class App {
  private readonly git: GitService;
  private readonly ai: LLM;
  private readonly staging: StagingService;
  private readonly context: ContextBuilder;
  private readonly commitGenerator: CommitGenerator;
  private readonly issueRefs: string[] | null;
  private readonly fastMode: boolean;
  private readonly gitPR: GitPRService;
  private readonly githubCli: GitHubCLIService;

  constructor(fastMode = false) {
    this.fastMode = fastMode;
    this.git = new GitService(config);
    this.ai = createLLM(config);
    this.staging = new StagingService(this.git, config);
    this.context = new ContextBuilder(this.git, config);
    this.commitGenerator = new CommitGenerator(this.ai, config);
    this.issueRefs = this.parseIssueRefs();
    this.gitPR = new GitPRService(this.git, config);
    this.githubCli = new GitHubCLIService(this.git);
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

      const files = this.git.getStagedFileNames();
      const ctx = this.context.build(files);

      let estimatedTokens = estimateCommitTokens(
        this.commitGenerator,
        files,
        ctx,
      );

      UI.renderTokenEstimate(estimatedTokens);

      let message = await this.commitGenerator.generate(files, ctx);

      while (true) {
        UI.render(message, config);

        const action = await UI.actionMenu(config);

        if (action === "commit") {
          this.commit(message);
        }

        if (action === "regen") {
          this.commitGenerator.extraInstruction = "";

          estimatedTokens = estimateCommitTokens(
            this.commitGenerator,
            files,
            ctx,
          );

          UI.renderTokenEstimate(estimatedTokens);

          message = await this.commitGenerator.generate(files, ctx);
          continue;
        }

        if (action === "refine") {
          const text = await UI.refineInput(config);
          this.commitGenerator.extraInstruction = text;

          estimatedTokens = estimateCommitTokens(
            this.commitGenerator,
            files,
            ctx,
          );

          UI.renderTokenEstimate(estimatedTokens);

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
    this.git.stageFiles(["."]);

    const files = this.git.getStagedFileNames();

    if (!files.trim()) {
      UI.renderNothingToCommit();
      process.exit(0);
    }

    const ctx = this.context.build(files);

    UI.renderTokenEstimate(
      estimateCommitTokens(this.commitGenerator, files, ctx),
    );

    const message = await this.commitGenerator.generate(files, ctx);

    this.commit(message);
  }

  private commit(message: string): never {
    const finalMessage = this.appendIssueRefs(message);

    this.git.createCommit(finalMessage);
    UI.renderCommitCreated(this.git.getLastCommitStats());

    process.exit(0);
  }

  buildPRContext(baseBranch: string = "origin/main"): PRContext {
    return this.context.buildPRContext(baseBranch);
  }

  private renderPRFailure(result: {
    message: string;
    suggestedCommand?: string;
  }): never {
    console.log(`\n  ✖ ${result.message}`);

    if (result.suggestedCommand) {
      console.log(`  → ${result.suggestedCommand}`);
    }

    console.log("");
    process.exit(1);
  }

  async runPRInteractive(baseBranch?: string): Promise<void> {
    const baseSummaries = this.gitPR.getAvailablePRBaseSummaries();

    if (!baseBranch && !baseSummaries.length) {
      console.log(
        "\n  ✖ No remote base branches found. Run git fetch --all --prune or pass a base branch directly, e.g. gw p origin/main\n",
      );
      process.exit(1);
    }

    const selectedBaseBranch =
      baseBranch ??
      (await UI.selectBranch(
        baseSummaries,
        "Select base branch for PR:",
      ));

    const preflightError = this.githubCli.getPreflightError(selectedBaseBranch);

    if (preflightError) {
      switch (preflightError.status) {
        case "already_exists":
          if (preflightError.url) {
            UI.renderPRCreated(preflightError.url);
          } else {
            console.log("\n  ✔ Pull request already exists.\n");
          }

          process.exit(0);
          return;

        case "not_pushed":
        case "unpushed_commits":
        case "gh_unauthenticated":
        case "gh_missing":
        case "failed":
          this.renderPRFailure(preflightError);
          return;

        case "created":
          UI.renderPRCreated(preflightError.url);
          process.exit(0);
          return;
      }
    }

    if (!this.gitPR.hasPRChangesAgainst(selectedBaseBranch)) {
      console.log(
        `\n  ✖ No PR changes found against ${selectedBaseBranch}.\n`,
      );
      process.exit(1);
    }

    const prContext = this.buildPRContext(selectedBaseBranch);
    const prGenerator = new PRGenerator(this.ai, config);

    UI.renderTokenEstimate(
      estimatePRTokens(prGenerator, prContext),
      "PR tokens",
    );

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
        const result = this.githubCli.createPullRequestFromCurrentBranch(
          selectedBaseBranch,
          title,
          description,
        );

        switch (result.status) {
          case "created":
            UI.renderPRCreated(result.url);
            process.exit(0);
            return;

          case "already_exists":
            if (result.url) {
              UI.renderPRCreated(result.url);
            } else {
              console.log("\n  ✔ Pull request already exists.\n");
            }

            process.exit(0);
            return;

          case "not_pushed":
          case "unpushed_commits":
          case "gh_unauthenticated":
          case "gh_missing":
          case "failed":
            this.renderPRFailure(result);
        }
      }

      UI.renderCancelled();
      process.exit(0);
    }
  }
}
