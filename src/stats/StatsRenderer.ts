import chalk from "chalk";
import { UsageTracker } from "./UsageTracker.js";
import type { UsageEntry } from "../types/types.js";
import { GracefulExit } from "../errors.js";

type AggregateStats = {
  count: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  files: number;
  changedLines: number;
  additions: number;
  deletions: number;
  durationMs: number;
  successes: number;
  failures: number;
};

export class StatsRenderer {
  private readonly tracker: UsageTracker;

  constructor() {
    this.tracker = new UsageTracker();
  }

  render(period?: string): never {
    if (!this.tracker.isAvailable()) {
      console.log(
        chalk.yellow("\n  ⚠ Not inside a git repository — no stats available.\n"),
      );
      throw new GracefulExit(1);
    }

    const data = this.tracker.load();

    if (!data.entries.length) {
      console.log(
        chalk.dim("\n  No usage recorded yet. Run gw commit or gw pr first.\n"),
      );
      throw new GracefulExit(0);
    }

    const filtered = period
      ? this.filterByPeriod(data.entries, period)
      : data.entries;

    if (!filtered.length) {
      console.log(chalk.dim(`\n  No usage found for period: ${period}\n`));
      throw new GracefulExit(0);
    }

    const border = chalk.dim("─".repeat(72));

    console.log("");
    console.log(border);
    console.log(chalk.bold.blue("  Git Writer Usage Stats"));

    if (period) {
      console.log(chalk.dim(`  Period: ${period}`));
    }

    console.log(border);

    this.renderSummary(filtered);
    this.renderWorkload(filtered);
    this.renderTokenBreakdown(filtered);
    this.renderEfficiency(filtered);
    this.renderByCommand(filtered);
    this.renderByMode(filtered);
    this.renderByDay(filtered);
    this.renderTopBranches(filtered);
    this.renderModels(filtered);
    this.renderErrors(filtered);

    console.log(border);
    console.log(
      chalk.dim(
        `  ${data.entries.length.toLocaleString()} total entries stored in .git/git-writer/usage.jsonl`,
      ),
    );
    console.log("");

    throw new GracefulExit(0);
  }

  renderReset(): never {
    this.tracker.clear();
    console.log(chalk.green("\n  ✔ Usage stats cleared.\n"));
    throw new GracefulExit(0);
  }

  private renderSummary(entries: UsageEntry[]): void {
    const stats = this.aggregate(entries);
    const avgTokens = this.safeAverage(stats.tokens, stats.count);
    const avgDurationMs = this.safeAverage(stats.durationMs, stats.count);
    const successRate = this.safePercent(stats.successes, stats.count);

    console.log("");
    console.log(chalk.bold("  Summary"));
    console.log(
      `  ${chalk.cyan(this.formatNumber(stats.count))} generation${stats.count !== 1 ? "s" : ""}  ` +
        `${chalk.yellow(this.formatNumber(stats.tokens))} tokens  ` +
        `${chalk.dim(this.formatNumber(avgTokens))} avg/run`,
    );
    console.log(
      `  ${chalk.green(`${successRate}% success`)}  ` +
        `${stats.failures ? chalk.red(`${this.formatNumber(stats.failures)} failed`) : chalk.dim("0 failed")}  ` +
        `${chalk.dim(this.formatDuration(avgDurationMs))} avg duration`,
    );
  }

  private renderWorkload(entries: UsageEntry[]): void {
    const stats = this.aggregate(entries);
    const avgFiles = this.safeAverage(stats.files, stats.count);
    const avgChangedLines = this.safeAverage(stats.changedLines, stats.count);

    if (!stats.files && !stats.changedLines) return;

    console.log("");
    console.log(chalk.bold("  Workload"));
    console.log(
      `  ${chalk.dim(this.formatNumber(stats.files))} files  ` +
        `${chalk.dim(avgFiles.toFixed(1))} avg/run`,
    );

    if (stats.changedLines > 0) {
      console.log(
        `  ${chalk.dim(this.formatNumber(stats.changedLines))} changed lines  ` +
          `${chalk.green(`+${this.formatNumber(stats.additions)}`)}  ` +
          `${chalk.red(`-${this.formatNumber(stats.deletions)}`)}  ` +
          `${chalk.dim(avgChangedLines.toFixed(1))} avg/run`,
      );
    }
  }

  private renderTokenBreakdown(entries: UsageEntry[]): void {
    const stats = this.aggregate(entries);

    if (
      !stats.inputTokens &&
      !stats.outputTokens &&
      !stats.reasoningTokens &&
      !stats.cachedTokens
    ) {
      return;
    }

    const parts = [
      `${chalk.yellow(this.formatNumber(stats.inputTokens))} input`,
      `${chalk.yellow(this.formatNumber(stats.outputTokens))} output`,
    ];

    if (stats.reasoningTokens > 0) {
      parts.push(`${chalk.dim(this.formatNumber(stats.reasoningTokens))} internal reasoning`);
    }

    if (stats.cachedTokens > 0) {
      parts.push(`${chalk.dim(this.formatNumber(stats.cachedTokens))} cached`);
    }

    console.log("");
    console.log(chalk.bold("  Tokens"));
    console.log(`  ${parts.join("  ")}`);
  }

  private renderEfficiency(entries: UsageEntry[]): void {
    const stats = this.aggregate(entries);

    if (!stats.count || !stats.tokens) return;

    const tokensPerFile = stats.files > 0 ? stats.tokens / stats.files : 0;
    const tokensPerLine =
      stats.changedLines > 0 ? stats.tokens / stats.changedLines : 0;

    console.log("");
    console.log(chalk.bold("  Efficiency"));
    console.log(
      `  ${chalk.dim(this.formatNumber(this.safeAverage(stats.tokens, stats.count)))} tokens/run` +
        (tokensPerFile > 0
          ? `  ${chalk.dim(this.formatNumber(tokensPerFile))} tokens/file`
          : "") +
        (tokensPerLine > 0
          ? `  ${chalk.dim(this.formatNumber(tokensPerLine))} tokens/changed line`
          : ""),
    );
  }

  private renderByCommand(entries: UsageEntry[]): void {
    const byCommand = new Map<string, AggregateStats>();

    for (const entry of entries) {
      this.addAggregate(byCommand, entry.command, entry);
    }

    const rows = [...byCommand.entries()].sort(
      ([, a], [, b]) => b.tokens - a.tokens,
    );

    if (!rows.length) return;

    console.log("");
    console.log(chalk.bold("  Commands"));

    for (const [command, stats] of rows) {
      const avgTokens = this.safeAverage(stats.tokens, stats.count);
      const avgDurationMs = this.safeAverage(stats.durationMs, stats.count);

      console.log(
        `  ${this.padPlain(command, 8, this.colorCommand(command))}  ` +
          `${chalk.cyan(this.formatNumber(stats.count))} run${stats.count !== 1 ? "s" : ""}  ` +
          `${chalk.yellow(this.formatNumber(stats.tokens))} tokens  ` +
          `${chalk.dim(this.formatNumber(avgTokens))} avg/run  ` +
          `${chalk.dim(this.formatDuration(avgDurationMs))} avg`,
      );
    }
  }

  private renderByMode(entries: UsageEntry[]): void {
    const byMode = new Map<string, AggregateStats>();

    for (const entry of entries) {
      this.addAggregate(byMode, entry.fastMode ? "fast" : "interactive", entry);
    }

    const rows = [...byMode.entries()].sort(
      ([, a], [, b]) => b.count - a.count,
    );

    if (!rows.length) return;

    console.log("");
    console.log(chalk.bold("  Mode"));

    for (const [mode, stats] of rows) {
      const avgTokens = this.safeAverage(stats.tokens, stats.count);

      console.log(
        `  ${chalk.cyan(mode)}  ` +
          chalk.dim(
            `${stats.count} run${stats.count !== 1 ? "s" : ""}  ` +
              `${this.formatNumber(stats.tokens)} tokens  ` +
              `${this.formatNumber(avgTokens)} avg/run`,
          ),
      );
    }
  }

  private renderByDay(entries: UsageEntry[]): void {
    const byDay = new Map<string, AggregateStats>();

    for (const entry of entries) {
      const day = entry.timestamp.slice(0, 10);
      this.addAggregate(byDay, day, entry);
    }

    const days = [...byDay.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 7);

    if (!days.length) return;

    console.log("");
    console.log(chalk.bold("  Recent days"));

    const maxTokens = Math.max(...days.map(([, stats]) => stats.tokens), 1);

    for (const [day, stats] of days) {
      const avgTokens = this.safeAverage(stats.tokens, stats.count);

      console.log(
        `  ${chalk.dim(day)}  ${this.renderBar(stats.tokens, maxTokens)} ` +
          chalk.dim(
            `${stats.count} run${stats.count !== 1 ? "s" : ""}  ` +
              `${this.formatNumber(stats.tokens)} tok  ` +
              `${this.formatNumber(avgTokens)} avg`,
          ),
      );
    }
  }

  private renderTopBranches(entries: UsageEntry[]): void {
    const byBranch = new Map<string, AggregateStats>();

    for (const entry of entries) {
      this.addAggregate(byBranch, entry.branch || "unknown", entry);
    }

    const top = [...byBranch.entries()]
      .sort(([, a], [, b]) => b.tokens - a.tokens)
      .slice(0, 5);

    if (!top.length) return;

    console.log("");
    console.log(chalk.bold("  Branches"));

    for (const [branch, stats] of top) {
      const avgTokens = this.safeAverage(stats.tokens, stats.count);

      console.log(
        `  ${chalk.cyan(branch)}  ` +
          chalk.dim(
            `${stats.count} run${stats.count !== 1 ? "s" : ""}  ` +
              `${this.formatNumber(stats.tokens)} tokens  ` +
              `${this.formatNumber(avgTokens)} avg/run`,
          ),
      );
    }
  }

  private renderModels(entries: UsageEntry[]): void {
    const byModel = new Map<string, AggregateStats>();

    for (const entry of entries) {
      const provider = entry.provider || "unknown";
      const reasoningModel = entry.reasoningModel || "unknown";
      const generationModel = entry.generationModel || "unknown";

      const model =
        reasoningModel === generationModel
          ? `${provider}: ${reasoningModel}`
          : `${provider}: ${reasoningModel} → ${generationModel}`;

      this.addAggregate(byModel, model, entry);
    }

    const rows = [...byModel.entries()]
      .sort(([, a], [, b]) => b.tokens - a.tokens)
      .slice(0, 5);

    if (!rows.length) return;

    console.log("");
    console.log(chalk.bold("  Models"));

    for (const [model, stats] of rows) {
      const avgTokens = this.safeAverage(stats.tokens, stats.count);

      console.log(
        `  ${chalk.cyan(model)}  ` +
          chalk.dim(
            `${stats.count} run${stats.count !== 1 ? "s" : ""}  ` +
              `${this.formatNumber(stats.tokens)} tokens  ` +
              `${this.formatNumber(avgTokens)} avg/run`,
          ),
      );
    }
  }

  private renderErrors(entries: UsageEntry[]): void {
    const failed = entries.filter((entry) => entry.success === false || entry.errorCode);

    if (!failed.length) return;

    const byError = new Map<string, number>();

    for (const entry of failed) {
      const code = entry.errorCode || "unknown";
      byError.set(code, (byError.get(code) ?? 0) + 1);
    }

    console.log("");
    console.log(chalk.bold("  Errors"));

    for (const [code, count] of [...byError.entries()].sort(([, a], [, b]) => b - a)) {
      console.log(
        `  ${chalk.red(code)}  ${chalk.dim(`${count} occurrence${count !== 1 ? "s" : ""}`)}`,
      );
    }
  }

  private aggregate(entries: UsageEntry[]): AggregateStats {
    return entries.reduce<AggregateStats>(
      (stats, entry) => ({
        count: stats.count + 1,
        tokens: stats.tokens + this.getTokens(entry),
        inputTokens: stats.inputTokens + (entry.inputTokens ?? 0),
        outputTokens: stats.outputTokens + (entry.outputTokens ?? 0),
        reasoningTokens: stats.reasoningTokens + (entry.reasoningTokens ?? 0),
        cachedTokens: stats.cachedTokens + (entry.cachedTokens ?? 0),
        files: stats.files + entry.fileCount,
        changedLines: stats.changedLines + (entry.changedLines ?? 0),
        additions: stats.additions + (entry.additions ?? 0),
        deletions: stats.deletions + (entry.deletions ?? 0),
        durationMs: stats.durationMs + (entry.durationMs ?? 0),
        successes: stats.successes + (entry.success === false ? 0 : 1),
        failures: stats.failures + (entry.success === false ? 1 : 0),
      }),
      {
        count: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0,
        files: 0,
        changedLines: 0,
        additions: 0,
        deletions: 0,
        durationMs: 0,
        successes: 0,
        failures: 0,
      },
    );
  }

  private addAggregate(
    map: Map<string, AggregateStats>,
    key: string,
    entry: UsageEntry,
  ): void {
    const existing = map.get(key) ?? {
      count: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      files: 0,
      changedLines: 0,
      additions: 0,
      deletions: 0,
      durationMs: 0,
      successes: 0,
      failures: 0,
    };

    map.set(key, {
      count: existing.count + 1,
      tokens: existing.tokens + this.getTokens(entry),
      inputTokens: existing.inputTokens + (entry.inputTokens ?? 0),
      outputTokens: existing.outputTokens + (entry.outputTokens ?? 0),
      reasoningTokens: existing.reasoningTokens + (entry.reasoningTokens ?? 0),
      cachedTokens: existing.cachedTokens + (entry.cachedTokens ?? 0),
      files: existing.files + entry.fileCount,
      changedLines: existing.changedLines + (entry.changedLines ?? 0),
      additions: existing.additions + (entry.additions ?? 0),
      deletions: existing.deletions + (entry.deletions ?? 0),
      durationMs: existing.durationMs + (entry.durationMs ?? 0),
      successes: existing.successes + (entry.success === false ? 0 : 1),
      failures: existing.failures + (entry.success === false ? 1 : 0),
    });
  }

  private getTokens(entry: UsageEntry): number {
    return entry.usedTokens ?? 0;
  }

  private renderBar(value: number, max: number): string {
    const width = 20;
    const length = max > 0 ? Math.max(1, Math.round((value / max) * width)) : 1;
    const bar = "█".repeat(length).padEnd(width);

    return chalk.cyan(bar);
  }

  private colorCommand(command: string): string {
    switch (command) {
      case "commit":
        return chalk.green(command);

      case "pr":
        return chalk.blue(command);

      default:
        return chalk.cyan(command);
    }
  }

  private padPlain(value: string, width: number, rendered = value): string {
    return rendered + " ".repeat(Math.max(0, width - value.length));
  }

  private formatNumber(value: number): string {
    return Math.round(value).toLocaleString();
  }

  private formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "0ms";
    if (ms < 1_000) return `${Math.round(ms)}ms`;

    const seconds = ms / 1_000;

    if (seconds < 60) {
      return `${seconds.toFixed(1)}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);

    return `${minutes}m ${remainingSeconds}s`;
  }

  private safeAverage(total: number, count: number): number {
    return count > 0 ? Math.round(total / count) : 0;
  }

  private safePercent(value: number, total: number): number {
    return total > 0 ? Math.round((value / total) * 100) : 0;
  }

  private filterByPeriod(entries: UsageEntry[], period: string): UsageEntry[] {
    const cutoff = this.getPeriodCutoff(period);

    if (!cutoff) {
      return entries;
    }

    return entries.filter((entry) => {
      const timestamp = new Date(entry.timestamp).getTime();
      return Number.isFinite(timestamp) && timestamp >= cutoff.getTime();
    });
  }

  private getPeriodCutoff(period: string): Date | null {
    const now = new Date();

    switch (period) {
      case "today":
        return new Date(now.getFullYear(), now.getMonth(), now.getDate());

      case "week": {
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - 7);
        return cutoff;
      }

      case "month": {
        const cutoff = new Date(now);
        cutoff.setMonth(cutoff.getMonth() - 1);
        return cutoff;
      }

      default:
        return null;
    }
  }
}
