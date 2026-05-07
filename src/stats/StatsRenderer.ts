import chalk from "chalk";
import { UsageTracker } from "./UsageTracker.js";
import type { UsageEntry } from "../types/types.js";
import { GracefulExit } from "../errors.js";

export class StatsRenderer {
  private readonly tracker: UsageTracker;

  constructor() {
    this.tracker = new UsageTracker();
  }

  render(period?: string): never {
    if (!this.tracker.isAvailable()) {
      console.log(chalk.yellow("\n  ⚠ Not inside a git repository — no stats available.\n"));
      throw new GracefulExit(1);
    }

    const data = this.tracker.load();

    if (!data.entries.length) {
      console.log(chalk.dim("\n  No usage recorded yet. Run gw commit or gw pr first.\n"));
      throw new GracefulExit(0);
    }

    const filtered = period ? this.filterByPeriod(data.entries, period) : data.entries;

    if (!filtered.length) {
      console.log(chalk.dim(`\n  No usage found for period: ${period}\n`));
      throw new GracefulExit(0);
    }

    const border = chalk.dim("─".repeat(60));

    console.log("");
    console.log(border);
    console.log(chalk.bold.blue("  Git Writer Usage Stats"));

    if (period) {
      console.log(chalk.dim(`  Period: ${period}`));
    }

    console.log(border);

    this.renderOverview(filtered);
    this.renderByCommand(filtered);
    this.renderByDay(filtered);
    this.renderTopBranches(filtered);

    console.log(border);
    console.log(
      chalk.dim(`  ${data.entries.length} total entries stored in .git/git-writer/usage.json`),
    );
    console.log("");

    throw new GracefulExit(0);
  }

  renderReset(): never {
    this.tracker.clear();
    console.log(chalk.green("\n  ✔ Usage stats cleared.\n"));
    throw new GracefulExit(0);
  }

  private renderOverview(entries: UsageEntry[]): void {
    const totalTokens = entries.reduce((sum, e) => sum + e.estimatedTokens, 0);
    const totalFiles = entries.reduce((sum, e) => sum + e.fileCount, 0);
    const avgTokens = Math.round(totalTokens / entries.length);

    console.log("");
    console.log(chalk.bold("  Overview"));
    console.log(
      `  ${chalk.cyan(entries.length.toString())} generations  ` +
      `${chalk.yellow("~" + totalTokens.toLocaleString())} total tokens  ` +
      `${chalk.dim("~" + avgTokens.toLocaleString())} avg/run`,
    );
    console.log(`  ${chalk.dim(totalFiles.toLocaleString())} files processed`);
  }

  private renderByCommand(entries: UsageEntry[]): void {
    const commits = entries.filter((e) => e.command === "commit");
    const prs = entries.filter((e) => e.command === "pr");

    console.log("");
    console.log(chalk.bold("  By command"));

    if (commits.length) {
      const tokens = commits.reduce((s, e) => s + e.estimatedTokens, 0);
      console.log(
        `  ${chalk.green("commit")}  ${commits.length} runs  ~${tokens.toLocaleString()} tokens`,
      );
    }

    if (prs.length) {
      const tokens = prs.reduce((s, e) => s + e.estimatedTokens, 0);
      console.log(
        `  ${chalk.blue("pr    ")}  ${prs.length} runs  ~${tokens.toLocaleString()} tokens`,
      );
    }
  }

  private renderByDay(entries: UsageEntry[]): void {
    const byDay = new Map<string, { count: number; tokens: number }>();

    for (const entry of entries) {
      const day = entry.timestamp.slice(0, 10);
      const existing = byDay.get(day) ?? { count: 0, tokens: 0 };

      byDay.set(day, {
        count: existing.count + 1,
        tokens: existing.tokens + entry.estimatedTokens,
      });
    }

    const days = [...byDay.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 7);

    console.log("");
    console.log(chalk.bold("  Recent days"));

    const maxTokens = Math.max(...days.map(([, d]) => d.tokens));

    for (const [day, stats] of days) {
      const barLength = maxTokens > 0
        ? Math.max(1, Math.round((stats.tokens / maxTokens) * 20))
        : 1;

      const bar = chalk.cyan("█".repeat(barLength));
      const label = chalk.dim(day);
      const info = chalk.dim(
        `${stats.count} run${stats.count !== 1 ? "s" : ""}  ~${stats.tokens.toLocaleString()} tok`,
      );

      console.log(`  ${label}  ${bar} ${info}`);
    }
  }

  private renderTopBranches(entries: UsageEntry[]): void {
    const byBranch = new Map<string, { count: number; tokens: number }>();

    for (const entry of entries) {
      const existing = byBranch.get(entry.branch) ?? { count: 0, tokens: 0 };

      byBranch.set(entry.branch, {
        count: existing.count + 1,
        tokens: existing.tokens + entry.estimatedTokens,
      });
    }

    const top = [...byBranch.entries()]
      .sort(([, a], [, b]) => b.tokens - a.tokens)
      .slice(0, 5);

    if (!top.length) return;

    console.log("");
    console.log(chalk.bold("  Top branches"));

    for (const [branch, stats] of top) {
      console.log(
        `  ${chalk.cyan(branch)}  ` +
        chalk.dim(`${stats.count} run${stats.count !== 1 ? "s" : ""}  ~${stats.tokens.toLocaleString()} tokens`),
      );
    }
  }

  private filterByPeriod(entries: UsageEntry[], period: string): UsageEntry[] {
    const now = Date.now();
    let cutoff: number;

    switch (period) {
      case "today":
        cutoff = now - 24 * 60 * 60 * 1000;
        break;

      case "week":
        cutoff = now - 7 * 24 * 60 * 60 * 1000;
        break;

      case "month":
        cutoff = now - 30 * 24 * 60 * 60 * 1000;
        break;

      default:
        return entries;
    }

    return entries.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
  }
}
