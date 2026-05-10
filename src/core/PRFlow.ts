import clipboard from "clipboardy";

import type { AppConfig } from "../config/config.js";
import type { PRContextBuilder } from "../context/PRContextBuilder.js";
import { GracefulExit, UserCancelledError } from "../errors.js";
import { PRGenerator } from "../generation/PRGenerator.js";
import type { GitHubCLIService } from "../git/GitHubCliService.js";
import type { GitPRService } from "../git/GitPRService.js";
import type { LLM } from "../llm/LLM.js";
import type { UsageTracker } from "../stats/UsageTracker.js";
import type { PRContext } from "../types/types.js";
import { UI } from "../ui/UI.js";
import type { UsageEntryBuilder } from "./App.js";

export class PRFlow {
  constructor(
    private readonly deps: {
      gitPR: GitPRService;
      githubCli: GitHubCLIService;
      prContext: PRContextBuilder;
      ai: LLM;
      tracker: UsageTracker;
      buildUsageEntry: UsageEntryBuilder;
      config: AppConfig;
    },
  ) {}

  buildContext(baseBranch: string = "origin/main"): PRContext {
    return this.deps.prContext.build(baseBranch);
  }

  async run(baseBranch?: string): Promise<void> {
    const baseSummaries = this.deps.gitPR.getAvailablePRBaseSummaries();

    if (!baseBranch && !baseSummaries.length) {
      console.log(
        "\n  ✖ No remote base branches found. Run git fetch --all --prune or pass a base branch directly, e.g. gw p origin/main\n",
      );
      throw new GracefulExit(1);
    }

    await this.handleUnpushedCommitsWarning();

    const selectedBaseBranch =
      baseBranch ??
      (await UI.selectBranch(baseSummaries, "Select base branch for PR:"));

    const preflightError =
      this.deps.githubCli.getPreflightError(selectedBaseBranch);

    if (preflightError) {
      switch (preflightError.status) {
        case "already_exists":
          if (preflightError.url) {
            UI.renderPRCreated(preflightError.url);
          } else {
            UI.renderPullRequestAlreadyExists();
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

    if (!this.deps.gitPR.hasPRChangesAgainst(selectedBaseBranch)) {
      UI.renderNoPRChanges(selectedBaseBranch);
      throw new GracefulExit(1);
    }

    const prContext = this.buildContext(selectedBaseBranch);
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
        fastMode: false,
        success: true,
      }),
    );

    while (true) {
      UI.renderPRPreview(selectedBaseBranch, title, description);

      const action = await UI.prActionMenu();

      if (action === "copy") {
        await clipboard.write(`${title}\n\n${description}`);
        UI.renderCopied("Copied PR to clipboard");
        throw new GracefulExit(0);
      }

      if (action === "create") {
        const result =
          this.deps.githubCli.createPullRequestFromCurrentBranch(
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
              UI.renderPullRequestAlreadyExists();
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

      if (action === "cancel") {
        UI.renderCancelled();
        throw new UserCancelledError();
      }

      throw new Error(`Unknown PR action: ${action}`);
    }
  }

  private async handleUnpushedCommitsWarning(): Promise<void> {
    const info = this.deps.gitPR.getUnpushedCommitsInfo();

    if (info.hasUpstream && info.count === 0) {
      return;
    }

    const action = await UI.unpushedCommitsWarningMenu(info);

    if (action === "continue") {
      return;
    }

    if (action === "push") {
      this.deps.gitPR.pushCurrentBranch(!info.hasUpstream);
      return;
    }

    UI.renderCancelled();
    throw new UserCancelledError();
  }

  private renderPRFailure(result: {
    message: string;
    suggestedCommand?: string;
  }): never {
    UI.renderPRFailure(result);
    throw new GracefulExit(1);
  }
}
