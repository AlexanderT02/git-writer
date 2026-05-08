import clipboard from "clipboardy";

import type { LLMProviderConfig, LLMProviderName } from "../config/config.js";
import { config } from "../config/config.js";
import { CommitGenerator } from "../generation/CommitGenerator.js";
import { CommitContextBuilder } from "../context/CommitContextBuilder.js";
import { PRContextBuilder } from "../context/PRContextBuilder.js";
import { GitService } from "../git/GitService.js";
import { createLLMProvider } from "../llm/Factory.js";
import { StagingService } from "../staging/StagingService.js";
import { UI } from "../ui/UI.js";
import type { LLM } from "../llm/LLM.js";
import type { PRContext, UsageEntry } from "../types/types.js";
import { PRGenerator } from "../generation/PRGenerator.js";
import { GitPRService } from "../git/GitPRService.js";
import { GitHubCLIService } from "../git/GitHubCliService.js";
import {
  estimateCommitTokens,
  estimatePRTokens,
} from "../llm/estimate/generationEstimate.js";
import { GracefulExit, UserCancelledError } from "../errors.js";
import { UsageTracker } from "../stats/UsageTracker.js";

type GenerationUsage = {
  reasoning?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
    cachedTokens?: number;
  };
  generation?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
    cachedTokens?: number;
  };
  totalTokens: number;
};

export class App {
  private readonly git: GitService;
  private readonly ai: LLM;
  private readonly staging: StagingService;
  private readonly commitContext: CommitContextBuilder;
  private readonly prContext: PRContextBuilder;
  private readonly commitGenerator: CommitGenerator;
  private issueRefs: string[] = [];
  private readonly providerName: LLMProviderName;
  private readonly llmConfig: LLMProviderConfig;
  private readonly fastMode: boolean;
  private readonly gitPR: GitPRService;
  private readonly githubCli: GitHubCLIService;
  private readonly tracker: UsageTracker;

  constructor(
    fastMode = false,
    issueRefs: string[] = [],
    providerOverride?: LLMProviderName,
  ) {
    this.fastMode = fastMode;
    this.issueRefs = issueRefs;

    this.providerName = providerOverride ?? config.llm.defaultProvider;

    this.llmConfig = {
      ...config.llm.providers[this.providerName],
      provider: this.providerName,
    };

    this.git = new GitService(config);
    this.ai = createLLMProvider(config, this.providerName);
    this.staging = new StagingService(this.git, config);
    this.commitContext = new CommitContextBuilder(this.git, config);
    this.prContext = new PRContextBuilder(this.git, config);
    this.commitGenerator = new CommitGenerator(this.ai, config);
    this.gitPR = new GitPRService(this.git, config);
    this.githubCli = new GitHubCLIService(this.git);
    this.tracker = new UsageTracker();
  }

  private appendIssueRefs(message: string): string {
    if (!this.issueRefs.length) return message;

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

      const startedAt = Date.now();

      let generated = await this.commitGenerator.generate(files, ctx);
      let message = generated.message;
      let durationMs = Date.now() - startedAt;

      while (true) {
        UI.render(message, config);

        const action = await UI.actionMenu(config);

        if (action === "commit") {
          this.commit(message, {
            files,
            diff: ctx._diff ?? "",
            usedTokens: generated.usage.totalTokens,
            usage: generated.usage,
            durationMs,
            fastMode: false,
          });
        }

        if (action === "regen") {
          this.commitGenerator.extraInstruction = "";

          const regenStartedAt = Date.now();
          generated = await this.commitGenerator.generate(files, ctx);
          durationMs = Date.now() - regenStartedAt;
          message = generated.message;

          continue;
        }

        if (action === "refine") {
          const text = await UI.refineInput(config);
          this.commitGenerator.extraInstruction = text;

          const refineStartedAt = Date.now();
          generated = await this.commitGenerator.generate(files, ctx);
          durationMs = Date.now() - refineStartedAt;
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

    const startedAt = Date.now();
    const generated = await this.commitGenerator.generate(files, ctx);
    const durationMs = Date.now() - startedAt;

    this.commit(generated.message, {
      files,
      diff: ctx._diff ?? "",
      usedTokens: generated.usage.totalTokens,
      usage: generated.usage,
      durationMs,
      fastMode: true,
    });
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
    meta: {
      files: string;
      diff: string;
      usedTokens: number;
      usage: GenerationUsage;
      durationMs: number;
      fastMode: boolean;
    },
  ): never {
    const finalMessage = this.appendIssueRefs(message);

    this.git.createCommit(finalMessage);

    this.tracker.record(
      this.buildUsageEntry("commit", {
        files: meta.files,
        diff: meta.diff,
        usage: meta.usage,
        usedTokens: meta.usedTokens,
        durationMs: meta.durationMs,
        fastMode: meta.fastMode,
        success: true,
      }),
    );

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

    const startedAt = Date.now();
    const generatedPR = await prGenerator.generate(prContext);
    const durationMs = Date.now() - startedAt;

    const { title, description } = generatedPR;

    this.tracker.record(
      this.buildUsageEntry("pr", {
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

  private buildUsageEntry(
    command: "commit" | "pr",
    meta: {
      files?: string;
      diff: string;
      usage: GenerationUsage;
      usedTokens: number;
      durationMs: number;
      success: boolean;
      fastMode: boolean;
      errorCode?: string;
    },
  ): UsageEntry {
    const lineStats = this.extractLineStats(meta.diff);
    const llmCalls = this.buildLLMCalls(meta.usage);

    return {
      timestamp: new Date().toISOString(),
      command,
      provider: this.providerName,
      reasoningModel: this.llmConfig.reasoningModel,
      generationModel: this.llmConfig.generationModel,

      llmCalls,

      usedTokens: meta.usedTokens,
      inputTokens: llmCalls.reduce((sum, call) => sum + call.tokens.inputTokens, 0),
      outputTokens: llmCalls.reduce((sum, call) => sum + call.tokens.outputTokens, 0),
      reasoningTokens: this.sumOptionalTokenField(llmCalls, "reasoningTokens"),
      cachedTokens: this.sumOptionalTokenField(llmCalls, "cachedTokens"),

      fileCount: this.countFiles(command, meta.files ?? meta.diff),
      changedLines: lineStats.additions + lineStats.deletions,
      additions: lineStats.additions,
      deletions: lineStats.deletions,

      branch: this.git.getCurrentBranch(),

      success: meta.success,
      durationMs: meta.durationMs,
      errorCode: meta.errorCode,

      fastMode: meta.fastMode,
    };
  }

  private countFiles(command: "commit" | "pr", diffOrFiles: string): number {
    if (command === "commit") {
      return diffOrFiles.split("\n").filter(Boolean).length;
    }

    return diffOrFiles
      .split("\n")
      .filter((line) => line.startsWith("diff --git")).length;
  }

  private extractLineStats(text: string): {
    additions: number;
    deletions: number;
  } {
    let additions = 0;
    let deletions = 0;

    for (const line of text.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) {
        continue;
      }

      if (line.startsWith("+")) {
        additions++;
        continue;
      }

      if (line.startsWith("-")) {
        deletions++;
      }
    }

    return { additions, deletions };
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

  private buildLLMCalls(usage: GenerationUsage): UsageEntry["llmCalls"] {
    const calls: UsageEntry["llmCalls"] = [];

    if (usage.reasoning) {
      calls.push({
        role: "reasoning",
        provider: this.providerName,
        model: this.llmConfig.reasoningModel,
        tokens: {
          inputTokens: usage.reasoning.inputTokens,
          outputTokens: usage.reasoning.outputTokens,
          totalTokens: usage.reasoning.totalTokens,
          reasoningTokens: usage.reasoning.reasoningTokens,
          cachedTokens: usage.reasoning.cachedTokens,
        },
        success: true,
      });
    }

    if (usage.generation) {
      calls.push({
        role: "generation",
        provider: this.providerName,
        model: this.llmConfig.generationModel,
        tokens: {
          inputTokens: usage.generation.inputTokens,
          outputTokens: usage.generation.outputTokens,
          totalTokens: usage.generation.totalTokens,
          reasoningTokens: usage.generation.reasoningTokens,
          cachedTokens: usage.generation.cachedTokens,
        },
        success: true,
      });
    }

    return calls;
  }

  private sumOptionalTokenField(
    calls: UsageEntry["llmCalls"],
    field: "reasoningTokens" | "cachedTokens",
  ): number | undefined {
    const total = calls.reduce((sum, call) => {
      return sum + (call.tokens[field] ?? 0);
    }, 0);

    return total > 0 ? total : undefined;
  }
}
