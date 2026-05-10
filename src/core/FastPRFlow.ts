import chalk from "chalk";
import { select } from "@inquirer/prompts";

import type { AppConfig } from "../config/config.js";
import type { LLM } from "../llm/LLM.js";
import type { PRContextBuilder } from "../context/PRContextBuilder.js";
import type { GitService } from "../git/GitService.js";
import type { GitPRService } from "../git/GitPRService.js";
import type { GitHubCLIService } from "../git/GitHubCliService.js";
import { PRGenerator } from "../generation/PRGenerator.js";
import { UI } from "../ui/UI.js";
import { GracefulExit, UserCancelledError } from "../errors.js";
import type { UsageTracker } from "../stats/UsageTracker.js";
import type { UsageEntryBuilder } from "./App.js";
import type { FastCommitFlow } from "./FastCommitFlow.js";
import type { PRFlow } from "./PRFlow.js";

type PushConfirmationAction =
  | "push"
  | "cancel"
  | "undo_commits";

export class FastPRFlow {
  constructor(
    private readonly deps: {
      fastCommitFlow: FastCommitFlow;
      prFlow: PRFlow;
      git: GitService;
      ai: LLM;
      gitPR: GitPRService;
      githubCli: GitHubCLIService;
      prContext: PRContextBuilder;
      tracker: UsageTracker;
      buildUsageEntry: UsageEntryBuilder;
      config: AppConfig;
    },
  ) {}

  async run(baseBranch?: string, force = false): Promise<void> {
    const baseSummaries = this.deps.gitPR.getAvailablePRBaseSummaries();

    if (!baseBranch && !baseSummaries.length) {
      console.log(
        "\n  ✖ No remote base branches found. Run git fetch --all --prune or pass a base branch directly.\n",
      );
      throw new GracefulExit(1);
    }

    const selectedBaseBranch =
      baseBranch ??
      (await UI.selectBranch(baseSummaries, "Select base branch for PR:"));

    this.validatePR(selectedBaseBranch);

    const headBeforeFastCommit = this.deps.git.getCurrentHeadSha();

    const commitResult = await this.deps.fastCommitFlow.run({
      exitOnComplete: false,
    });

    if (commitResult.status === "nothing_to_commit") {
      throw new GracefulExit(0);
    }

    if (!force) {
      const action = await this.confirmPush();

      switch (action) {
        case "push":
          break;

        case "undo_commits":
          this.discardCreatedCommitsKeepFilesStaged(headBeforeFastCommit);
          throw new GracefulExit(0);

        case "cancel":
          UI.renderCancelled();
          throw new UserCancelledError();
      }
    }

    this.push();

    if (force) {
      await this.generateAndCreatePR(selectedBaseBranch);
    } else {
      await this.deps.prFlow.run(selectedBaseBranch);
    }
  }

  private validatePR(baseBranch: string): void {
    const readinessError = this.deps.githubCli.getReadinessError();

    if (readinessError) {
      console.log(`\n  ✖ ${readinessError.message}`);

      if (
        "suggestedCommand" in readinessError &&
        readinessError.suggestedCommand
      ) {
        console.log(`  → ${readinessError.suggestedCommand}`);
      }

      console.log("");
      throw new GracefulExit(1);
    }

    const existingUrl =
      this.deps.githubCli.getExistingPullRequestUrl(baseBranch);

    if (existingUrl) {
      UI.renderPRCreated(existingUrl);
      console.log(chalk.dim("  Pull request already exists.\n"));
      throw new GracefulExit(0);
    }
  }

  private async confirmPush(
  ): Promise<PushConfirmationAction> {
    return select<PushConfirmationAction>({
      message: "Push commit(s) and continue to PR?",
      choices: [
        {
          name: "Confirm — push and create PR",
          value: "push",
        },
        {
          name: "Undo commits and keep files staged",
          value: "undo_commits",
        },
        {
          name: "Cancel",
          value: "cancel",
        },
      ],
    });
  }

  private discardCreatedCommitsKeepFilesStaged(targetSha: string): void {
    try {
      this.deps.git.resetSoftTo(targetSha);

      console.log(
        chalk.green("\n  ✔ Discarded created commit(s) and kept files staged\n"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`\n  ✖ Failed to discard created commit(s): ${message}\n`);
      throw new GracefulExit(1);
    }
  }

  private push(): void {
    const branch = this.deps.git.getCurrentBranch();

    console.log(chalk.dim(`\n  Pushing ${branch}...`));

    try {
      this.deps.git.runGit(["push", "-u", "origin", branch]);
    } catch {
      try {
        this.deps.git.runGit(["push", "--set-upstream", "origin", branch]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`\n  ✖ Push failed: ${message}\n`);
        throw new GracefulExit(1);
      }
    }

    console.log(chalk.green("  ✔ Pushed\n"));
  }

  private async generateAndCreatePR(baseBranch: string): Promise<void> {
    if (!this.deps.gitPR.hasPRChangesAgainst(baseBranch)) {
      console.log(`\n  ✖ No PR changes found against ${baseBranch}.\n`);
      throw new GracefulExit(1);
    }

    const prContext = this.deps.prContext.build(baseBranch);
    const prGenerator = new PRGenerator(this.deps.ai, this.deps.config);

    const startedAt = Date.now();
    const generatedPR = await prGenerator.generate(prContext);
    const durationMs = Date.now() - startedAt;

    const { title, description } = generatedPR;

    this.deps.tracker.record(
      this.deps.buildUsageEntry("pr", {
        diff: prContext.diff,
        usage: generatedPR.usage,
        usedTokens: generatedPR.usage.totalTokens,
        durationMs,
        fastMode: true,
        success: true,
      }),
    );

    UI.renderPRPreview(baseBranch, title, description);

    const result = this.deps.githubCli.createPullRequestFromCurrentBranch(
      baseBranch,
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

      default:
        console.log(`\n  ✖ ${result.message}`);

        if ("suggestedCommand" in result && result.suggestedCommand) {
          console.log(`  → ${result.suggestedCommand}`);
        }

        console.log("");
        throw new GracefulExit(1);
    }
  }
}
