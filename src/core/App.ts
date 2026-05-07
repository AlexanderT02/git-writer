import clipboard from "clipboardy";

import { config } from "../config/config.js";
import { CommitGenerator } from "../generation/CommitGenerator.js";
import { CommitContextBuilder } from "../context/CommitContextBuilder.js";
import { PRContextBuilder } from "../context/PRContextBuilder.js";
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
} from "../llm/estimate/generationEstimate.js";
import { GracefulExit, UserCancelledError } from "../errors.js";
import { UsageTracker } from "../stats/UsageTracker.js";

export class App {
  private readonly git: GitService;
  private readonly ai: LLM;
  private readonly staging: StagingService;
  private readonly commitContext: CommitContextBuilder;
  private readonly prContext: PRContextBuilder;
  private readonly commitGenerator: CommitGenerator;
  private readonly issueRefs: string[] | null;
  private readonly fastMode: boolean;
  private readonly gitPR: GitPRService;
  private readonly githubCli: GitHubCLIService;
  private readonly tracker: UsageTracker;

  constructor(fastMode = false) {
    this.fastMode = fastMode;
    this.git = new GitService(config);
    this.ai = createLLM(config);
    this.staging = new StagingService(this.git, config);
    this.commitContext = new CommitContextBuilder(this.git, config);
    this.prContext = new PRContextBuilder(this.git, config);
    this.commitGenerator = new CommitGenerator(this.ai, config);
    this.issueRefs = this.parseIssueRefs();
    this.gitPR = new GitPRService(this.git, config);
    this.githubCli = new GitHubCLIService(this.git);
    this.tracker = new UsageTracker();
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
      const ctx = this.commitContext.build(files);

      let generated = await this.commitGenerator.generate(files, ctx);
      let message = generated.message;

      while (true) {
        UI.render(message, config);

        const action = await UI.actionMenu(config);

        if (action === "commit") {
          const fileCount = files.split("\n").filter(Boolean).length;
          this.commit(message, fileCount, generated.usage.totalTokens);
        }

        if (action === "regen") {
          this.commitGenerator.extraInstruction = "";

          generated = await this.commitGenerator.generate(files, ctx);
          message = generated.message;

          continue;
        }

        if (action === "refine") {
          const text = await UI.refineInput(config);
          this.commitGenerator.extraInstruction = text;

          generated = await this.commitGenerator.generate(files, ctx);
          message = generated.message;

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
        throw new UserCancelledError();
      }
    }
  }

  private async runCommitFast(): Promise<void> {
    this.git.stageFiles(["."]);

    const files = this.git.getStagedFileNames();

    if (!files.trim()) {
      UI.renderNothingToCommit();
      throw new GracefulExit(0);
    }

    this.assertFastModeFileLimit(files);

    const ctx = this.commitContext.build(files);

    const estimatedTokens = estimateCommitTokens(
      this.commitGenerator,
      files,
      ctx,
    );

    this.assertFastModeTokenLimit(estimatedTokens);

    const generated = await this.commitGenerator.generate(files, ctx);

    const fileCount = files.split("\n").filter(Boolean).length;
    this.commit(generated.message, fileCount, generated.usage.totalTokens);
  }

  private assertFastModeFileLimit(files: string): void {
    const fileCount = files.split("\n").filter(Boolean).length;
    const limit = config.context.fastModeFileLimit;

    if (fileCount <= limit) return;

    console.log(
      `\n  ✖ Fast mode aborted: ${fileCount} staged files exceed the limit of ${limit}.\n`,
    );
    console.log("  → Use interactive mode to stage fewer files.\n");

    throw new GracefulExit(1);
  }

  private assertFastModeTokenLimit(estimatedTokens: number): void {
    const limit = config.context.fastModeTokenLimit;

    if (estimatedTokens <= limit) return;

    console.log(
      `\n  ✖ Fast mode aborted: estimated ${estimatedTokens} tokens exceed the limit of ${limit}.\n`,
    );
    console.log("  → Use interactive mode or stage fewer/lighter changes.\n");

    throw new GracefulExit(1);
  }

  private commit(
    message: string,
    fileCount: number = 0,
    usedTokens: number = 0,
  ): never {
    const finalMessage = this.appendIssueRefs(message);

    this.git.createCommit(finalMessage);

    this.tracker.record({
      command: "commit",
      provider: config.llm.provider,
      reasoningModel: config.llm.reasoningModel,
      generationModel: config.llm.generationModel,
      estimatedTokens: usedTokens,
      fileCount,
      branch: this.git.getCurrentBranch(),
    });

    UI.renderCommitCreated(this.git.getLastCommitStats());
    throw new GracefulExit(0);
  }

  buildPRContext(baseBranch: string = "origin/main"): PRContext {
    return this.prContext.build(baseBranch);
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
    throw new GracefulExit(1);
  }

  async runPRInteractive(baseBranch?: string): Promise<void> {
    const baseSummaries = this.gitPR.getAvailablePRBaseSummaries();

    if (!baseBranch && !baseSummaries.length) {
      console.log(
        "\n  ✖ No remote base branches found. Run git fetch --all --prune or pass a base branch directly, e.g. gw p origin/main\n",
      );
      throw new GracefulExit(1);
    }

    const selectedBaseBranch =
      baseBranch ??
      (await UI.selectBranch(baseSummaries, "Select base branch for PR:"));

    const preflightError = this.githubCli.getPreflightError(selectedBaseBranch);

    if (preflightError) {
      switch (preflightError.status) {
        case "already_exists":
          if (preflightError.url) {
            UI.renderPRCreated(preflightError.url);
          } else {
            console.log("\n  ✔ Pull request already exists.\n");
          }

          throw new GracefulExit(0);

        case "not_pushed":
        case "unpushed_commits":
        case "gh_unauthenticated":
        case "gh_missing":
        case "failed":
          this.renderPRFailure(preflightError);
          return;

        case "created":
          UI.renderPRCreated(preflightError.url);
          throw new GracefulExit(0);
      }
    }

    if (!this.gitPR.hasPRChangesAgainst(selectedBaseBranch)) {
      console.log(
        `\n  ✖ No PR changes found against ${selectedBaseBranch}.\n`,
      );
      throw new GracefulExit(1);
    }

    const prContext = this.buildPRContext(selectedBaseBranch);
    const prGenerator = new PRGenerator(this.ai, config);

    this.renderLargePRTokenEstimate(prGenerator, prContext);

    const generatedPR = await prGenerator.generate(prContext);
    const { title, description } = generatedPR;

    const prFileCount = prContext.diff
      .split("\n")
      .filter((line) => line.startsWith("diff --git")).length;

    this.tracker.record({
      command: "pr",
      provider: config.llm.provider,
      reasoningModel: config.llm.reasoningModel,
      generationModel: config.llm.generationModel,
      estimatedTokens: generatedPR.usage.totalTokens,
      fileCount: prFileCount,
      branch: this.git.getCurrentBranch(),
    });

    while (true) {
      UI.renderPRPreview(selectedBaseBranch, title, description);

      const action = await UI.prActionMenu();

      if (action === "copy") {
        await clipboard.write(`${title}\n\n${description}`);
        UI.renderCopied("Copied PR to clipboard");
        throw new GracefulExit(0);
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
            throw new GracefulExit(0);

          case "already_exists":
            if (result.url) {
              UI.renderPRCreated(result.url);
            } else {
              console.log("\n  ✔ Pull request already exists.\n");
            }

            throw new GracefulExit(0);

          case "not_pushed":
          case "unpushed_commits":
          case "gh_unauthenticated":
          case "gh_missing":
          case "failed":
            this.renderPRFailure(result);
        }
      }

      UI.renderCancelled();
      throw new UserCancelledError();
    }
  }

  private renderLargePRTokenEstimate(
    prGenerator: PRGenerator,
    prContext: PRContext,
  ): void {
    const estimatedTokens = estimatePRTokens(prGenerator, prContext);
    const warningThreshold = config.context.fastModeTokenLimit * 3;

    if (estimatedTokens <= warningThreshold) return;

    UI.renderTokenEstimate(estimatedTokens, "Large PR token estimate");
  }
}
