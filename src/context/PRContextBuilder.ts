import type { AppConfig } from "../config/config.js";
import type { PRContext } from "../types/types.js";
import type { GitService } from "../git/GitService.js";
import {
  BaseContextBuilder,
  type ChangeSize,
  type ContextEntry,
  type ContextResult,
} from "./BaseContextBuilder.js";

type PRChangedEntry = ContextEntry;
type PRFileContextResult = ContextResult;

export class PRContextBuilder extends BaseContextBuilder {
  private currentBaseBranch = "origin/main";

  constructor(
    gitService: GitService,
    config: AppConfig,
  ) {
    super(gitService, config);
  }

  build(baseBranch: string = "origin/main"): PRContext {
    this.currentBaseBranch = baseBranch;

    const branchCtx = this.gitService.getCurrentBranchContext();

    const commits = this.gitService.runGitOrEmpty([
      "log",
      "--right-only",
      "--cherry-pick",
      "--oneline",
      "--no-merges",
      `${baseBranch}...HEAD`,
    ]);

    const diff = this.buildDiffPreview(baseBranch);
    const fileContexts = this.buildFileContexts(baseBranch);

    return {
      branch: branchCtx.branch,
      issue: branchCtx.issue,
      commits,
      diff,
      fileContexts: fileContexts.map((ctx) => ctx.text).join("\n\n"),
    };
  }

  buildFileContexts(baseBranch: string): PRFileContextResult[] {
    this.currentBaseBranch = baseBranch;

    const changedFiles = this.prioritizeEntries(
      this.getChangedEntries(baseBranch),
    );

    /**
     * PRs get 3x the commit context budget.
     */
    const totalBudget = this.getBudget(3);
    let remaining = totalBudget;
    const results: PRFileContextResult[] = [];

    for (const entry of changedFiles) {
      if (remaining <= 0) {
        results.push(this.skipped(entry));
        continue;
      }

      const perFileBudget = Math.min(
        remaining,
        this.getPerFileBudget(changedFiles.length, totalBudget),
      );

      const result = this.buildSingleFileContext(
        baseBranch,
        entry,
        perFileBudget,
      );

      remaining -= this.cost(result.text);
      results.push(result);
    }

    return results;
  }

  private buildSingleFileContext(
    baseBranch: string,
    entry: PRChangedEntry,
    budget: number,
  ): PRFileContextResult {
    if (!entry.file) {
      return this.unknownFile();
    }

    if (this.isContentExcluded(entry.file)) {
      return this.excluded(entry);
    }

    const size = this.getPRChangeSize(baseBranch, entry.file);

    if (size.binary) {
      return this.binary(entry);
    }

    if (entry.status === "D") {
      return this.deleted(entry, size);
    }

    /**
     * Same strategy as commit builder:
     * cheap size check first, then compact diff, then regular diff, then truncate.
     *
     * PR context intentionally does not use BEFORE/AFTER full file blobs.
     * For PR descriptions, diffs are cheaper and usually more relevant.
     */
    const compactDiff = this.compactDiff(baseBranch, entry);

    if (compactDiff.text && this.cost(compactDiff.text) <= budget) {
      return compactDiff;
    }

    const regularDiff = this.regularDiff(baseBranch, entry);

    if (regularDiff.text && this.cost(regularDiff.text) <= budget) {
      return regularDiff;
    }

    return this.truncatedDiff(
      entry,
      compactDiff.text || regularDiff.text,
      budget,
    );
  }

  private buildDiffPreview(baseBranch: string): string {
    const diff = this.gitService.runGitOrEmpty([
      "diff",
      `${baseBranch}...HEAD`,
    ]);

    return diff
      .split("\n")
      .slice(0, this.config.commit.reasoningDiffPreviewLines)
      .join("\n");
  }

  private getChangedEntries(baseBranch: string): PRChangedEntry[] {
    const raw = this.gitService.runGitOrEmpty([
      "diff",
      "--name-status",
      `${baseBranch}...HEAD`,
    ]);

    if (!raw.trim()) return [];

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => this.parseNameStatusLine(line))
      .filter((entry) => entry.file);
  }

  private compactDiff(
    baseBranch: string,
    entry: PRChangedEntry,
  ): PRFileContextResult {
    const diff = this.gitService.runGitOrEmpty([
      "diff",
      `-U${this.getContextLines()}`,
      `${baseBranch}...HEAD`,
      "--",
      entry.file,
    ]);

    return diff
      ? {
        level: 1,
        text: `=== ${entry.file} (${entry.status}) [compact diff] ===\n${diff}`,
      }
      : this.noDiff(entry);
  }

  private regularDiff(
    baseBranch: string,
    entry: PRChangedEntry,
  ): PRFileContextResult {
    const diff = this.gitService.runGitOrEmpty([
      "diff",
      `${baseBranch}...HEAD`,
      "--",
      entry.file,
    ]);

    return diff
      ? {
        level: 0,
        text: `=== ${entry.file} (${entry.status}) [diff] ===\n${diff}`,
      }
      : this.noDiff(entry);
  }

  private getPRChangeSize(baseBranch: string, file: string): ChangeSize {
    const out = this.gitService.runGitOrEmpty([
      "diff",
      "--numstat",
      `${baseBranch}...HEAD`,
      "--",
      file,
    ]);

    return this.parseNumstat(out);
  }

  protected getChangeSize(file: string): ChangeSize {
    return this.getPRChangeSize(this.currentBaseBranch, file);
  }
}
