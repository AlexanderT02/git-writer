import type { LLMProviderConfig, LLMProviderName } from "../config/config.js";
import { config } from "../config/config.js";
import { CommitGenerator } from "../generation/CommitGenerator.js";
import { CommitContextBuilder } from "../context/CommitContextBuilder.js";
import { PRContextBuilder } from "../context/PRContextBuilder.js";
import { GitService } from "../git/GitService.js";
import { createLLMProvider } from "../llm/Factory.js";
import { StagingService } from "../staging/StagingService.js";
import type { LLM } from "../llm/LLM.js";
import type { PRContext, UsageEntry } from "../types/types.js";
import { GitPRService } from "../git/GitPRService.js";
import { GitHubCLIService } from "../git/GitHubCliService.js";
import { UsageTracker } from "../stats/UsageTracker.js";

import { CommitFlow } from "./CommitFlow.js";
import { FastCommitFlow } from "./FastCommitFlow.js";
import { PRFlow } from "./PRFlow.js";
import { FastPRFlow } from "./FastPRFlow.js";

export type GenerationUsage = {
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

export type UsageEntryBuilder = (
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
) => UsageEntry;

export class App {
  private readonly git: GitService;
  private readonly ai: LLM;
  private readonly staging: StagingService;
  private readonly commitContext: CommitContextBuilder;
  private readonly prContext: PRContextBuilder;
  private readonly commitGenerator: CommitGenerator;
  private readonly providerName: LLMProviderName;
  private readonly llmConfig: LLMProviderConfig;
  private readonly fastMode: boolean;
  private readonly forceMode: boolean;
  private readonly gitPR: GitPRService;
  private readonly githubCli: GitHubCLIService;
  private readonly tracker: UsageTracker;

  private readonly commitFlow: CommitFlow;
  private readonly fastCommitFlow: FastCommitFlow;
  private readonly prFlow: PRFlow;
  private readonly fastPRFlow: FastPRFlow;

  constructor(
    fastMode = false,
    issueRefs: string[] = [],
    providerOverride?: LLMProviderName,
    forceMode = false,
  ) {
    this.fastMode = fastMode;
    this.forceMode = forceMode;

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

    const buildUsageEntry: UsageEntryBuilder = this.buildUsageEntry.bind(this);

    this.commitFlow = new CommitFlow({
      git: this.git,
      staging: this.staging,
      commitContext: this.commitContext,
      commitGenerator: this.commitGenerator,
      tracker: this.tracker,
      buildUsageEntry,
      issueRefs,
    });

    this.fastCommitFlow = new FastCommitFlow({
      git: this.git,
      ai: this.ai,
      commitContext: this.commitContext,
      commitGenerator: this.commitGenerator,
      tracker: this.tracker,
      buildUsageEntry,
      issueRefs,
      config,
    });

    this.prFlow = new PRFlow({
      gitPR: this.gitPR,
      githubCli: this.githubCli,
      prContext: this.prContext,
      ai: this.ai,
      tracker: this.tracker,
      buildUsageEntry,
      config,
    });

    this.fastPRFlow = new FastPRFlow({
      fastCommitFlow: this.fastCommitFlow,
      prFlow: this.prFlow,
      git: this.git,
      ai: this.ai,
      gitPR: this.gitPR,
      githubCli: this.githubCli,
      prContext: this.prContext,
      tracker: this.tracker,
      buildUsageEntry,
      config,
    });
  }

  async runCommitInteractive(): Promise<void> {
    if (this.fastMode) {
      await this.fastCommitFlow.run({ exitOnComplete: true });
      return;
    }

    await this.commitFlow.run();
  }
  buildPRContext(baseBranch: string = "origin/main"): PRContext {
    return this.prContext.build(baseBranch);
  }

  async runPRInteractive(baseBranch?: string): Promise<void> {
    if (this.fastMode || this.forceMode) {
      return this.fastPRFlow.run(baseBranch, this.forceMode);
    }

    return this.prFlow.run(baseBranch);
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
      inputTokens: llmCalls.reduce(
        (sum, call) => sum + call.tokens.inputTokens,
        0,
      ),
      outputTokens: llmCalls.reduce(
        (sum, call) => sum + call.tokens.outputTokens,
        0,
      ),
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
