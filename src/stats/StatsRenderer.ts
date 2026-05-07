import chalk from "chalk";
import { UsageTracker } from "./UsageTracker.js";
import type { UsageEntry } from "../types/types.js";
import { GracefulExit } from "../errors.js";
import { CostEstimator } from "./CostEstimator.js";

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
  costUsd: number;
};

type ModelStats = {
  calls: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  costUsd: number;
  successes: number;
  failures: number;
  roles: Map<string, number>;
};

export class StatsRenderer {
  private readonly tracker: UsageTracker;
  private readonly cost: CostEstimator;

  constructor() {
    this.tracker = new UsageTracker();
    this.cost = new CostEstimator();
  }

  render(period?: string): never {
    if (!this.tracker.isAvailable()) {
      console.log(chalk.yellow("\n  Not inside a git repository.\n"));
      throw new GracefulExit(1);
    }

    const data = this.tracker.load();

    if (!data.entries.length) {
      console.log(chalk.dim("\n  No usage recorded yet.\n"));
      throw new GracefulExit(0);
    }

    const entries = period
      ? this.filterByPeriod(data.entries, period)
      : data.entries;

    if (!entries.length) {
      console.log(chalk.dim(`\n  No usage found for period: ${period}\n`));
      throw new GracefulExit(0);
    }

    const border = chalk.dim("─".repeat(68));

    console.log("");
    console.log(border);
    console.log(chalk.bold("  Git Writer Stats"));

    if (period) {
      console.log(chalk.dim(`  ${period}`));
    }

    console.log(border);

    this.renderSummary(entries);
    this.renderTokens(entries);
    this.renderModels(entries);
    this.renderCommands(entries);
    this.renderActivity(entries);
    this.renderContext(entries);
    this.renderErrors(entries);

    console.log(border);
    console.log(
      chalk.dim(
        `  ${this.formatNumber(data.entries.length)} entries · .git/git-writer/usage.jsonl`,
      ),
    );
    console.log("");

    throw new GracefulExit(0);
  }

  renderReset(): never {
    this.tracker.clear();
    console.log(chalk.green("\n  Usage stats cleared.\n"));
    throw new GracefulExit(0);
  }

  private renderSummary(entries: UsageEntry[]): void {
    const stats = this.aggregate(entries);

    console.log("");
    console.log(chalk.bold("  Summary"));
    console.log(
      `  ${chalk.cyan(this.formatNumber(stats.count))} runs  ` +
        `${chalk.yellow(this.formatNumber(stats.tokens))} tokens  ` +
        `${chalk.green(this.formatUsd(stats.costUsd))}  ` +
        `${chalk.dim(this.formatNumber(this.average(stats.tokens, stats.count)))} avg/run`,
    );
    console.log(
      `  ${chalk.green(`${this.percent(stats.successes, stats.count)}% success`)}  ` +
        `${stats.failures ? chalk.red(`${this.formatNumber(stats.failures)} failed`) : chalk.dim("0 failed")}  ` +
        `${chalk.dim(this.formatDuration(this.average(stats.durationMs, stats.count)))} avg duration`,
    );
  }

  private renderTokens(entries: UsageEntry[]): void {
    const stats = this.aggregate(entries);

    if (!stats.inputTokens && !stats.outputTokens) return;

    const parts = [
      `${chalk.yellow(this.formatNumber(stats.inputTokens))} input`,
      `${chalk.yellow(this.formatNumber(stats.outputTokens))} output`,
    ];

    if (stats.reasoningTokens > 0) {
      parts.push(
        `${chalk.dim(this.formatNumber(stats.reasoningTokens))} internal reasoning`,
      );
    }

    if (stats.cachedTokens > 0) {
      parts.push(`${chalk.dim(this.formatNumber(stats.cachedTokens))} cached`);
    }

    console.log("");
    console.log(chalk.bold("  Tokens"));
    console.log(`  ${parts.join("  ")}`);
  }

  private renderModels(entries: UsageEntry[]): void {
    const byModel = new Map<string, ModelStats>();

    for (const entry of entries) {
      for (const call of entry.llmCalls ?? []) {
        const key = `${call.provider || entry.provider || "unknown"}: ${
          call.model || "unknown"
        }`;

        this.addModelAggregate(byModel, key, call);
      }
    }

    const rows = [...byModel.entries()]
      .sort(([, a], [, b]) => b.tokens - a.tokens)
      .slice(0, 8);

    if (!rows.length) return;

    console.log("");
    console.log(chalk.bold("  Models"));

    for (const [model, stats] of rows) {
      this.renderModelRow(model, stats);
    }
  }

  private renderModelRow(model: string, stats: ModelStats): void {
    const avgTokens = this.average(stats.tokens, stats.calls);
    const roles = this.formatRoles(stats.roles);

    console.log(
      `  ${chalk.cyan(model)}  ` +
        chalk.dim(
          `${this.formatNumber(stats.calls)} calls  ` +
            `${this.formatNumber(stats.tokens)} tokens  ` +
            `${this.formatUsd(stats.costUsd)}  ` +
            `${this.formatNumber(avgTokens)} avg/call`,
        ),
    );

    const details = [
      `${this.formatNumber(stats.inputTokens)} input`,
      `${this.formatNumber(stats.outputTokens)} output`,
    ];

    if (stats.reasoningTokens > 0) {
      details.push(
        `${this.formatNumber(stats.reasoningTokens)} internal reasoning`,
      );
    }

    if (stats.cachedTokens > 0) {
      details.push(`${this.formatNumber(stats.cachedTokens)} cached`);
    }

    if (roles) {
      details.push(roles);
    }

    console.log(chalk.dim(`    ${details.join("  ")}`));
  }

  private renderCommands(entries: UsageEntry[]): void {
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
      console.log(
        `  ${this.pad(command, 8, this.colorCommand(command))}  ` +
          `${chalk.cyan(this.formatNumber(stats.count))} runs  ` +
          `${chalk.yellow(this.formatNumber(stats.tokens))} tokens  ` +
          `${chalk.green(this.formatUsd(stats.costUsd))}  ` +
          `${chalk.dim(this.formatNumber(this.average(stats.tokens, stats.count)))} avg/run  ` +
          `${chalk.dim(this.formatDuration(this.average(stats.durationMs, stats.count)))} avg`,
      );
    }
  }

  private renderActivity(entries: UsageEntry[]): void {
    const byDay = new Map<string, AggregateStats>();

    for (const entry of entries) {
      this.addAggregate(byDay, entry.timestamp.slice(0, 10), entry);
    }

    const days = [...byDay.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 7);

    if (!days.length) return;

    console.log("");
    console.log(chalk.bold("  Recent"));

    const maxTokens = Math.max(...days.map(([, stats]) => stats.tokens), 1);

    for (const [day, stats] of days) {
      console.log(
        `  ${chalk.dim(day)}  ${this.bar(stats.tokens, maxTokens)} ` +
          chalk.dim(
            `${this.formatNumber(stats.count)} runs  ` +
              `${this.formatNumber(stats.tokens)} tok  ` +
              `${this.formatUsd(stats.costUsd)}`,
          ),
      );
    }
  }

  private renderContext(entries: UsageEntry[]): void {
    const stats = this.aggregate(entries);

    if (!stats.files && !stats.changedLines) return;

    console.log("");
    console.log(chalk.bold("  Context"));
    console.log(
      `  ${chalk.dim(`${this.formatNumber(stats.files)} files`)}  ` +
        `${chalk.dim(`${this.formatNumber(this.average(stats.files, stats.count))} avg/run`)}`,
    );

    if (stats.changedLines > 0) {
      console.log(
        `  ${chalk.dim(`${this.formatNumber(stats.changedLines)} changed lines`)}  ` +
          `${chalk.green(`+${this.formatNumber(stats.additions)}`)}  ` +
          `${chalk.red(`-${this.formatNumber(stats.deletions)}`)}  ` +
          `${chalk.dim(`${this.formatNumber(this.average(stats.changedLines, stats.count))} avg/run`)}`,
      );
    }
  }

  private renderErrors(entries: UsageEntry[]): void {
    const failed = entries.filter(
      (entry) => entry.success === false || entry.errorCode,
    );

    if (!failed.length) return;

    const byError = new Map<string, number>();

    for (const entry of failed) {
      const code = entry.errorCode || "unknown";
      byError.set(code, (byError.get(code) ?? 0) + 1);
    }

    console.log("");
    console.log(chalk.bold("  Errors"));

    for (const [code, count] of [...byError.entries()].sort(
      ([, a], [, b]) => b - a,
    )) {
      console.log(
        `  ${chalk.red(code)}  ${chalk.dim(`${this.formatNumber(count)} occurrences`)}`,
      );
    }
  }

  private aggregate(entries: UsageEntry[]): AggregateStats {
    return entries.reduce<AggregateStats>(
      (stats, entry) => this.aggregateOne(stats, entry),
      this.emptyAggregate(),
    );
  }

  private addAggregate(
    map: Map<string, AggregateStats>,
    key: string,
    entry: UsageEntry,
  ): void {
    map.set(key, this.aggregateOne(map.get(key) ?? this.emptyAggregate(), entry));
  }

  private aggregateOne(stats: AggregateStats, entry: UsageEntry): AggregateStats {
    const cost = this.cost.estimateEntry(entry);

    return {
      count: stats.count + 1,
      tokens: stats.tokens + this.getTokens(entry),
      inputTokens: stats.inputTokens + this.getInputTokens(entry),
      outputTokens: stats.outputTokens + this.getOutputTokens(entry),
      reasoningTokens: stats.reasoningTokens + this.getReasoningTokens(entry),
      cachedTokens: stats.cachedTokens + this.getCachedTokens(entry),
      files: stats.files + (entry.fileCount ?? 0),
      changedLines: stats.changedLines + (entry.changedLines ?? 0),
      additions: stats.additions + (entry.additions ?? 0),
      deletions: stats.deletions + (entry.deletions ?? 0),
      durationMs: stats.durationMs + (entry.durationMs ?? 0),
      successes: stats.successes + (entry.success === false ? 0 : 1),
      failures: stats.failures + (entry.success === false ? 1 : 0),
      costUsd: stats.costUsd + cost.totalUsd,
    };
  }

  private addModelAggregate(
    map: Map<string, ModelStats>,
    key: string,
    call: UsageEntry["llmCalls"][number],
  ): void {
    const existing = map.get(key) ?? {
      calls: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      successes: 0,
      failures: 0,
      roles: new Map<string, number>(),
    };

    existing.calls += 1;
    existing.tokens += call.tokens.totalTokens;
    existing.inputTokens += call.tokens.inputTokens;
    existing.outputTokens += call.tokens.outputTokens;
    existing.reasoningTokens += call.tokens.reasoningTokens ?? 0;
    existing.cachedTokens += call.tokens.cachedTokens ?? 0;
    existing.costUsd += this.cost.estimateCall(call).totalUsd;
    existing.successes += call.success === false ? 0 : 1;
    existing.failures += call.success === false ? 1 : 0;
    existing.roles.set(call.role, (existing.roles.get(call.role) ?? 0) + 1);

    map.set(key, existing);
  }

  private emptyAggregate(): AggregateStats {
    return {
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
      costUsd: 0,
    };
  }

  private getTokens(entry: UsageEntry): number {
    return (
      entry.usedTokens ??
      entry.llmCalls?.reduce((sum, call) => sum + call.tokens.totalTokens, 0) ??
      0
    );
  }

  private getInputTokens(entry: UsageEntry): number {
    return (
      entry.inputTokens ??
      entry.llmCalls?.reduce((sum, call) => sum + call.tokens.inputTokens, 0) ??
      0
    );
  }

  private getOutputTokens(entry: UsageEntry): number {
    return (
      entry.outputTokens ??
      entry.llmCalls?.reduce((sum, call) => sum + call.tokens.outputTokens, 0) ??
      0
    );
  }

  private getReasoningTokens(entry: UsageEntry): number {
    return (
      entry.reasoningTokens ??
      entry.llmCalls?.reduce(
        (sum, call) => sum + (call.tokens.reasoningTokens ?? 0),
        0,
      ) ??
      0
    );
  }

  private getCachedTokens(entry: UsageEntry): number {
    return (
      entry.cachedTokens ??
      entry.llmCalls?.reduce(
        (sum, call) => sum + (call.tokens.cachedTokens ?? 0),
        0,
      ) ??
      0
    );
  }

  private bar(value: number, max: number): string {
    const width = 18;
    const length = max > 0 ? Math.max(1, Math.round((value / max) * width)) : 1;

    return chalk.cyan("█".repeat(length).padEnd(width));
  }

  private colorCommand(command: string): string {
    if (command === "commit") return chalk.green(command);
    if (command === "pr") return chalk.blue(command);

    return chalk.cyan(command);
  }

  private formatRoles(roles: Map<string, number>): string {
    return [...roles.entries()]
      .map(([role, count]) => `${this.formatNumber(count)} ${role}`)
      .join(", ");
  }

  private pad(value: string, width: number, rendered = value): string {
    return rendered + " ".repeat(Math.max(0, width - value.length));
  }

  private formatNumber(value: number): string {
    return Math.round(value).toLocaleString();
  }

  private formatUsd(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "$0.0000";
    if (value < 0.01) return `$${value.toFixed(4)}`;

    return `$${value.toFixed(2)}`;
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

  private average(total: number, count: number): number {
    return count > 0 ? Math.round(total / count) : 0;
  }

  private percent(value: number, total: number): number {
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
