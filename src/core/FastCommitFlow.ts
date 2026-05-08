import chalk from "chalk";

import type { AppConfig } from "../config/config.js";
import type { CommitGenerator } from "../generation/CommitGenerator.js";
import { ChangeGrouper } from "../generation/ChangeGrouper.js";
import type { CommitContextBuilder } from "../context/CommitContextBuilder.js";
import type { GitService } from "../git/GitService.js";
import type { LLM } from "../llm/LLM.js";
import type { FileGroup } from "../types/types.js";
import { UI } from "../ui/UI.js";
import { GracefulExit } from "../errors.js";
import type { UsageTracker } from "../stats/UsageTracker.js";
import { estimateCommitTokens } from "../llm/estimate/generationEstimate.js";
import type { UsageEntryBuilder } from "./App.js";

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

  async run(): Promise<void> {
    this.deps.git.stageFiles(["."]);

    const files = this.deps.git.getStagedFileNames();

    if (!files.trim()) {
      UI.renderNothingToCommit();
      throw new GracefulExit(0);
    }

    const fileCount = files.split("\n").filter(Boolean).length;
    const shouldSplit = fileCount >= this.deps.config.grouping.splitThreshold;

    if (!shouldSplit) {
      return this.runSingle(files);
    }

    return this.runSplit();
  }

  private async runSingle(files: string): Promise<void> {
    this.assertFileLimit(files);

    const ctx = this.deps.commitContext.build(files);

    const estimatedTokens = estimateCommitTokens(
      this.deps.commitGenerator,
      files,
      ctx,
    );

    this.assertTokenLimit(estimatedTokens);

    const startedAt = Date.now();
    const generated = await this.deps.commitGenerator.generate(files, ctx);
    const durationMs = Date.now() - startedAt;

    this.commit(generated.message, {
      files,
      diff: ctx._diff ?? "",
      usedTokens: generated.usage.totalTokens,
      usage: generated.usage,
      durationMs,
    });
  }

  private async runSplit(): Promise<void> {
    this.deps.git.resetStagedFiles();

    const grouper = new ChangeGrouper(
      this.deps.git,
      this.deps.ai,
      this.deps.config,
    );
    const summaries = grouper.collectSummaries();

    if (summaries.length === 0) {
      UI.renderNothingToCommit();
      throw new GracefulExit(0);
    }

    console.log(
      chalk.cyan(`\n   Found ${summaries.length} changed files — grouping...\n`),
    );

    const { groups } = await grouper.group(summaries);

    this.renderGroupingSummary(groups);

    let commitCount = 0;

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;

      console.log(
        chalk.dim(`\n   Commit ${i + 1}/${groups.length}: ${group.label}`),
      );

      this.deps.git.stageFiles(group.files);

      const files = this.deps.git.getStagedFileNames();

      if (!files.trim()) {
        console.log(
          chalk.yellow(
            `  ⚠ Group "${group.label}" has no stageable files — skipping`,
          ),
        );
        continue;
      }

      const ctx = this.deps.commitContext.build(files);

      const startedAt = Date.now();
      const generated = await this.deps.commitGenerator.generate(files, ctx);
      const durationMs = Date.now() - startedAt;

      const finalMessage = this.appendIssueRefs(generated.message);
      this.deps.git.createCommit(finalMessage);

      this.deps.tracker.record(
        this.deps.buildUsageEntry("commit", {
          files,
          diff: ctx._diff ?? "",
          usage: generated.usage,
          usedTokens: generated.usage.totalTokens,
          durationMs,
          fastMode: true,
          success: true,
        }),
      );

      const stats = this.deps.git.getLastCommitStats();
      const statsStr = stats
        ? chalk.dim(
          `(${chalk.cyan(stats.files)} files  ${chalk.green(
            "+" + stats.insertions,
          )}  ${chalk.red("-" + stats.deletions)})`,
        )
        : "";

      console.log(
        chalk.green(`  ✔ ${generated.message.split("\n")[0]}  ${statsStr}`),
      );

      commitCount++;
    }

    console.log(
      chalk.green.bold(
        `\n  ✔ Done — ${commitCount} commit${
          commitCount !== 1 ? "s" : ""
        } created\n`,
      ),
    );

    throw new GracefulExit(0);
  }

  private appendIssueRefs(message: string): string {
    if (!this.deps.issueRefs.length) return message;

    return `${message}\n\nrefs ${this.deps.issueRefs.join(", ")}`;
  }

  private commit(
    message: string,
    meta: {
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
    },
  ): never {
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

    UI.renderCommitCreated(this.deps.git.getLastCommitStats());
    throw new GracefulExit(0);
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

      for (const file of group.files.slice(0, 5)) {
        console.log(chalk.dim(`     ${file}`));
      }

      if (group.files.length > 5) {
        console.log(chalk.dim(`     ...and ${group.files.length - 5} more`));
      }
    }

    console.log("");
  }

  private assertFileLimit(files: string): void {
    const fileCount = files.split("\n").filter(Boolean).length;
    const limit = this.deps.config.context.fastModeFileLimit;

    if (fileCount <= limit) return;

    console.log(
      `\n  ✖ Fast mode aborted: ${fileCount} staged files exceed the limit of ${limit}.\n`,
    );
    console.log("  → Use interactive mode to stage fewer files.\n");

    throw new GracefulExit(1);
  }

  private assertTokenLimit(estimatedTokens: number): void {
    const limit = this.deps.config.context.fastModeTokenLimit;

    if (estimatedTokens <= limit) return;

    console.log(
      `\n  ✖ Fast mode aborted: estimated ${estimatedTokens} tokens exceed the limit of ${limit}.\n`,
    );
    console.log("  → Use interactive mode or stage fewer/lighter changes.\n");

    throw new GracefulExit(1);
  }
}
