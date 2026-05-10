import chalk from "chalk";

import type { AppConfig } from "../config/config.js";
import type { CommitGenerator } from "../generation/CommitGenerator.js";
import { ChangeGrouper } from "../generation/ChangeGrouper.js";
import type { CommitContextBuilder } from "../context/CommitContextBuilder.js";
import type { GitService } from "../git/GitService.js";
import type { LLM } from "../llm/LLM.js";
import type { CommitStats, FileGroup } from "../types/types.js";
import { UI } from "../ui/UI.js";
import { GracefulExit } from "../errors.js";
import type { UsageTracker } from "../stats/UsageTracker.js";
import type { UsageEntryBuilder } from "./App.js";

export type FastCommitResult =
  | { status: "committed"; commitCount: number }
  | { status: "nothing_to_commit" };

type FastCommitRunOptions = {
  exitOnComplete?: boolean;
};

type UsageMeta = {
  files: string;
  diff: string;
  usedTokens: number;
  usage: {
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
  durationMs: number;
};

export class FastCommitFlow {
  constructor(
    private readonly deps: {
      git: GitService;
      ai: LLM;
      commitContext: CommitContextBuilder;
      commitGenerator: CommitGenerator;
      tracker: UsageTracker;
      buildUsageEntry: UsageEntryBuilder;
      issueRefs: string[];
      config: AppConfig;
    },
  ) {}

  async run(options: FastCommitRunOptions = {}): Promise<FastCommitResult> {
    const exitOnComplete = options.exitOnComplete ?? true;

    this.deps.git.stageAllFiles();

    const files = this.deps.git.getStagedFileNames();

    if (!files.trim()) {
      UI.renderNothingToCommit();

      if (exitOnComplete) {
        throw new GracefulExit(0);
      }

      return { status: "nothing_to_commit" };
    }

    const fileCount = files.split("\n").filter(Boolean).length;
    const shouldSplit = fileCount >= this.deps.config.grouping.splitThreshold;

    const result = shouldSplit
      ? await this.runSplit()
      : await this.runSingle(files);

    if (exitOnComplete) {
      throw new GracefulExit(0);
    }

    return result;
  }

  private async runSingle(files: string): Promise<FastCommitResult> {
    const ctx = this.deps.commitContext.build(files);
    const startedAt = Date.now();
    const generated = await this.deps.commitGenerator.generate(files, ctx);
    const durationMs = Date.now() - startedAt;

    const stats = this.commit(generated.message, {
      files,
      diff: ctx._diff ?? "",
      usedTokens: generated.usage.totalTokens,
      usage: generated.usage,
      durationMs,
    });

    UI.renderCommitCreated(stats);

    console.log(
      chalk.green.bold(`\n  ✔ Done ${this.formatStats(stats)}\n`),
    );

    return { status: "committed", commitCount: 1 };
  }

  private async runSplit(): Promise<FastCommitResult> {
    this.deps.git.resetStagedFiles();

    const grouper = new ChangeGrouper(
      this.deps.git,
      this.deps.ai,
      this.deps.config,
    );

    const summaries = grouper.collectSummaries();

    if (summaries.length === 0) {
      UI.renderNothingToCommit();
      return { status: "nothing_to_commit" };
    }

    console.log(
      chalk.cyan(`\n  Grouping ${summaries.length} changed files...\n`),
    );

    const { groups } = await grouper.group(summaries);

    this.renderGroupingSummary(groups);

    let commitCount = 0;
    let totalStats: CommitStats = {
      files: "0",
      insertions: 0,
      deletions: 0,
    };

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;

      const failedFiles = this.stageGroupFiles(group);
      const files = this.deps.git.getStagedFileNames();

      if (!files.trim()) {
        console.log(
          chalk.yellow(`  ⚠ Skipped ${group.label}: no stageable files`),
        );
        continue;
      }

      this.renderSkippedGroupFiles(group, failedFiles);

      const ctx = this.deps.commitContext.build(files);

      const startedAt = Date.now();
      const generated = await this.deps.commitGenerator.generate(files, ctx);
      const durationMs = Date.now() - startedAt;

      const subject = generated.message.split("\n")[0] ?? group.label;

      console.log(
        chalk.dim(`\n  Commit ${i + 1}/${groups.length}: `) +
          chalk.white(subject),
      );

      const stats = this.commit(generated.message, {
        files,
        diff: ctx._diff ?? "",
        usage: generated.usage,
        usedTokens: generated.usage.totalTokens,
        durationMs,
      });

      totalStats = this.addStats(totalStats, stats);

      UI.renderCommitCreated(stats);

      commitCount++;
    }

    console.log(
      chalk.green.bold(
        `\n  ✔ Done — ${commitCount} commit${
          commitCount !== 1 ? "s" : ""
        } created ${this.formatStats(totalStats)}\n`,
      ),
    );

    return { status: "committed", commitCount };
  }

  private appendIssueRefs(message: string): string {
    if (!this.deps.issueRefs.length) return message;

    return `${message}\n\nrefs ${this.deps.issueRefs.join(", ")}`;
  }

  private commit(message: string, meta: UsageMeta): CommitStats | null {
    const finalMessage = this.appendIssueRefs(message);

    this.deps.git.createCommit(finalMessage);

    this.deps.tracker.record(
      this.deps.buildUsageEntry("commit", {
        files: meta.files,
        diff: meta.diff,
        usage: meta.usage,
        usedTokens: meta.usedTokens,
        durationMs: meta.durationMs,
        fastMode: true,
        success: true,
      }),
    );

    return this.deps.git.getLastCommitStats();
  }

  private renderGroupingSummary(groups: FileGroup[]): void {
    console.log(chalk.bold(`  ${groups.length} groups:\n`));

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;

      console.log(
        chalk.cyan(`  ${i + 1}. ${group.conventionalType}`) +
          chalk.white(`: ${group.label}`) +
          chalk.dim(
            ` — ${group.files.length} file${
              group.files.length !== 1 ? "s" : ""
            }`,
          ),
      );
    }

    console.log("");
  }

  private formatStats(stats?: CommitStats | null): string {
    if (!stats) return "";

    return chalk.dim(
      `(${chalk.cyan(stats.files)} files  ${chalk.green(
        `+${stats.insertions}`,
      )}  ${chalk.red(`-${stats.deletions}`)})`,
    );
  }

  private addStats(
    total: CommitStats,
    stats?: CommitStats | null,
  ): CommitStats {
    if (!stats) return total;

    return {
      files: String(this.toNumber(total.files) + this.toNumber(stats.files)),
      insertions: this.toNumber(total.insertions) + this.toNumber(stats.insertions),
      deletions: this.toNumber(total.deletions) + this.toNumber(stats.deletions),
    };
  }

  private toNumber(value: string | number): number {
    if (typeof value === "number") return value;

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : 0;
  }

  private stageGroupFiles(group: FileGroup): string[] {
    const failedFiles: string[] = [];

    for (const file of group.files) {
      try {
        this.deps.git.stageFiles([file]);
      } catch {
        failedFiles.push(file);
      }
    }

    return failedFiles;
  }

  private renderSkippedGroupFiles(group: FileGroup, failedFiles: string[]): void {
    if (failedFiles.length === 0) return;

    console.log(
      chalk.yellow(
        `  ⚠ Skipped ${failedFiles.length} file${
          failedFiles.length !== 1 ? "s" : ""
        } in ${group.label}: not stageable`,
      ),
    );
  }
}
