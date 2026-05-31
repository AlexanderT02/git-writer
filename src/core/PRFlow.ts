import clipboard from "clipboardy";

import type { AppConfig } from "../config/Config.js";
import type { PRContextBuilder } from "../context/PRContextBuilder.js";
import { GracefulExit, UserCancelledError } from "../Errors.js";
import { PRGenerator } from "../generation/PRGenerator.js";
import type { GitHubCLIService } from "../git/GitHubCliService.js";
import type { GitPRService } from "../git/GitPRService.js";
import type { LLM } from "../llm/LLM.js";
import type { UsageTracker } from "../stats/UsageTracker.js";
import type {
  BranchPRSummary,
  PRContext,
  PullRequestCreateResult,
  PullRequestUpdateResult,
} from "../types/Types.js";
import { UI } from "../ui/UI.js";
import type { PRContextStateStore } from "../pr/PRContextStateStore.js";
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
      prContextState: PRContextStateStore;
    },
  ) {}

  buildContext(baseBranch: string = "origin/main"): PRContext {
    return this.deps.prContext.build(baseBranch);
  }

  async run(baseBranch?: string): Promise<void> {
    const initialBaseSummaries = this.deps.gitPR.getAvailablePRBaseSummaries();

    if (!baseBranch && !initialBaseSummaries.length) {
      console.log(
        "\n  ✖ No remote base branches found. Run git fetch --all --prune or pass a base branch directly, e.g. gw p origin/main\n",
      );
      throw new GracefulExit(1);
    }

    await this.handleUnpushedCommitsWarning();

    const baseSummariesRaw = baseBranch
      ? initialBaseSummaries
      : this.deps.gitPR.getAvailablePRBaseSummaries();
    const baseSummaries = this.decorateBaseSummariesWithPRHints(baseSummariesRaw);

    const selectedBaseBranch =
      baseBranch ??
      (await UI.selectBranch(baseSummaries, "Select base branch for PR:"));

    if (!this.deps.gitPR.hasPRChangesAgainst(selectedBaseBranch)) {
      UI.renderNoPRChanges(selectedBaseBranch);
      throw new GracefulExit(1);
    }

    const existingPullRequest =
      this.deps.githubCli.getExistingPullRequest(selectedBaseBranch);
    const prContext = existingPullRequest
      ? this.deps.prContext.buildIncremental(selectedBaseBranch)
      : this.buildContext(selectedBaseBranch);
    const prGenerator = new PRGenerator(this.deps.ai, this.deps.config);

    const startedAt = Date.now();
    const generatedPR = existingPullRequest
      ? await prGenerator.generateFromExisting(prContext, {
        title: existingPullRequest.title,
        body: existingPullRequest.body,
      })
      : await prGenerator.generate(prContext);
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

      const action = await UI.prActionMenu({
        hasExistingPR: Boolean(existingPullRequest),
      });

      if (action === "copy") {
        await clipboard.write(`${title}\n\n${description}`);
        UI.renderCopied("Copied PR to clipboard");
        throw new GracefulExit(0);
      }

      if (action === "create") {
        this.ensureGitHubPRCanBeCreated(selectedBaseBranch);

        const result =
          this.deps.githubCli.createPullRequestFromCurrentBranch(
            selectedBaseBranch,
            title,
            description,
          );
        if (result.status === "created") {
          this.persistPRContextHead(selectedBaseBranch, result.url);
        }

        this.handleCreatePRResult(result);
      }

      if (action === "update") {
        const result =
          this.deps.githubCli.updatePullRequestFromCurrentBranch(
            selectedBaseBranch,
            title,
            description,
          );
        if (result.status === "updated") {
          this.persistPRContextHead(selectedBaseBranch, result.url);
        }

        this.handleUpdatePRResult(result);
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

  private ensureGitHubPRCanBeCreated(selectedBaseBranch: string): void {
    const preflightError =
      this.deps.githubCli.getPreflightError(selectedBaseBranch);

    if (!preflightError) return;

    switch (preflightError.status) {
      case "already_exists":
        if (preflightError.url) {
          UI.renderPRCreated(preflightError.url);
        } else {
          UI.renderPullRequestAlreadyExists();
        }

        throw new GracefulExit(0);

      case "created":
        UI.renderPRCreated(preflightError.url);
        throw new GracefulExit(0);

      case "not_pushed":
      case "unpushed_commits":
      case "gh_unauthenticated":
      case "gh_missing":
      case "failed":
        this.renderPRFailure(preflightError);
    }
  }

  private handleCreatePRResult(result: PullRequestCreateResult): never {
    switch (result.status) {
      case "created":
        if (!result.url) {
          this.renderPRFailure({
            message: "Pull request was created, but no URL was returned.",
          });
        }

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
        this.renderPRFailure({
          message: result.message ?? "Failed to create pull request.",
          suggestedCommand:
          "suggestedCommand" in result ? result.suggestedCommand : undefined,
        });
    }
  }

  private handleUpdatePRResult(result: PullRequestUpdateResult): never {
    switch (result.status) {
      case "updated":
        UI.renderPRUpdated(result.url);
        throw new GracefulExit(0);

      case "not_found":
      case "not_pushed":
      case "unpushed_commits":
      case "gh_unauthenticated":
      case "gh_missing":
      case "failed":
        this.renderPRFailure({
          message: result.message ?? "Failed to update pull request.",
          suggestedCommand:
            "suggestedCommand" in result ? result.suggestedCommand : undefined,
        });
    }
  }

  private renderPRFailure(result: {
    message: string;
    suggestedCommand?: string;
  }): never {
    UI.renderPRFailure(result);
    throw new GracefulExit(1);
  }

  private decorateBaseSummariesWithPRHints(
    summaries: BranchPRSummary[],
  ): BranchPRSummary[] {
    const currentBranch = this.deps.gitPR.getCurrentBranch();

    return summaries.map((summary) => {
      const existing = this.deps.githubCli.getExistingPullRequest(summary.branch);

      if (!existing) {
        return {
          ...summary,
          prActionHint: "create",
          contextHint: "new PR",
        };
      }

      const trackedHeadSha = this.deps.prContextState.getHeadSha(
        currentBranch,
        summary.branch,
      );
      const newerCommits = trackedHeadSha
        ? this.deps.gitPR.countCommitsSince(trackedHeadSha)
        : null;

      const contextHint =
        newerCommits === null
          ? "context status unknown"
          : newerCommits === 0
            ? "context up-to-date"
            : `${newerCommits} commit${newerCommits === 1 ? "" : "s"} not yet in PR context`;

      return {
        ...summary,
        prActionHint: "update",
        contextHint,
      };
    });
  }

  private persistPRContextHead(baseBranch: string, prUrl?: string): void {
    const headSha = this.deps.gitPR.getCurrentHeadSha();
    const currentBranch = this.deps.gitPR.getCurrentBranch();

    if (!headSha || !currentBranch) return;

    this.deps.prContextState.setHeadSha(
      currentBranch,
      baseBranch,
      headSha,
      prUrl,
    );
  }
}
