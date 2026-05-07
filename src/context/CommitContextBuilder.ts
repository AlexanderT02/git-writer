import type { AppConfig } from "../config/config.js";
import type {
  CommitContext,
  FileContextResult,
  StagedEntry,
} from "../types/types.js";
import type { GitService } from "../git/GitService.js";
import {
  BaseContextBuilder,
  type ChangeSize,
} from "./BaseContextBuilder.js";

export class CommitContextBuilder extends BaseContextBuilder {
  constructor(
    gitService: GitService,
    config: AppConfig,
  ) {
    super(gitService, config);
  }

  build(files: string): CommitContext {
    const fileList = files.split("\n").filter(Boolean);
    const fileCount = fileList.length;

    const branchCtx = this.gitService.getCurrentBranchContext();
    const stagedStats = this.gitService.getStagedShortStat();
    const recentCommits = this.gitService.getRecentCommitLines(
      this.config.git.recentCommitCount,
    );

    const stagedFileSummaries =
      fileCount > 1 ? this.gitService.getStagedFileSummaryLines() : "";

    const recentStyleHints =
      fileCount > 3
        ? this.gitService.getRecentCommitStyleHints(
          this.config.git.recentStyleCommitCount,
        )
        : "";

    const fileContexts = this.buildFileContexts();
    const hasAnyReducedContext = fileContexts.some((ctx) => ctx.level < 2);

    const changedSymbols = hasAnyReducedContext
      ? this.gitService.getChangedSymbolsFromStagedDiff()
      : "";

    const _diff = this.buildDiffPreview();

    return {
      ...branchCtx,
      stagedStats,
      stagedFileSummaries,
      recentStyleHints,
      recentCommits,
      changedSymbols,
      fileContext: fileContexts.map((ctx) => ctx.text).join("\n\n"),
      _diff,
    };
  }

  buildFileContexts(): FileContextResult[] {
    const staged = this.prioritizeEntries(this.getStagedEntries());
    let remaining = this.getBudget(1);
    const results: FileContextResult[] = [];

    for (const entry of staged) {
      if (remaining <= 0) {
        results.push(this.skipped(entry));
        continue;
      }

      const perFileBudget = Math.min(
        remaining,
        this.getPerFileBudget(staged.length, this.getBudget(1)),
      );

      const result = this.buildSingleFileContext(entry, perFileBudget);

      remaining -= this.cost(result.text);
      results.push(result);
    }

    return results;
  }

  private buildSingleFileContext(
    entry: StagedEntry,
    budget: number,
  ): FileContextResult {
    if (!entry.file) {
      return this.unknownFile();
    }

    const size = this.getChangeSize(entry.file);

    if (size.binary) {
      return this.binary(entry);
    }

    if (entry.status === "D") {
      return this.deleted(entry, size);
    }

    if (this.shouldTryFullContext(entry, size, budget)) {
      const before = this.getFileContent("HEAD", entry.file, entry.status);
      const after = this.getFileContent("INDEX", entry.file, entry.status);
      const full = this.level2(entry, before, after);

      if (this.cost(full.text) <= budget) {
        return full;
      }
    }

    const compactDiff = this.compactDiff(entry);

    if (compactDiff.text && this.cost(compactDiff.text) <= budget) {
      return compactDiff;
    }

    const regularDiff = this.regularDiff(entry);

    if (regularDiff.text && this.cost(regularDiff.text) <= budget) {
      return regularDiff;
    }

    return this.truncatedDiff(entry, compactDiff.text || regularDiff.text, budget);
  }

  private buildDiffPreview(): string {
    const diff = this.gitService.getStagedDiffForPrompt();

    return diff
      .split("\n")
      .slice(0, this.config.commit.reasoningDiffPreviewLines)
      .join("\n");
  }

  private regularDiff(entry: StagedEntry): FileContextResult {
    const diff = this.gitService.getStagedFileDiff(entry.file);

    return {
      level: 0,
      text: `=== ${entry.file} (${entry.status}) [diff] ===\n${
        diff || "[no diff]"
      }`,
    };
  }

  private compactDiff(entry: StagedEntry): FileContextResult {
    const diff = this.gitService.getStagedFileDiffWithContext(
      entry.file,
      this.getContextLines(),
    );

    return diff
      ? {
        level: 1,
        text: `=== ${entry.file} (${entry.status}) [compact diff] ===\n${diff}`,
      }
      : this.regularDiff(entry);
  }

  level0(entry: StagedEntry): FileContextResult {
    return this.regularDiff(entry);
  }

  level1(entry: StagedEntry): FileContextResult {
    return this.compactDiff(entry);
  }

  level2(entry: StagedEntry, before: string, after: string): FileContextResult {
    const parts = [`=== ${entry.file} (${entry.status}) [full] ===`];

    if (entry.status === "A" || !before) {
      parts.push("--- NEW FILE ---", after);
    } else {
      parts.push("--- BEFORE ---", before, "--- AFTER ---", after);
    }

    return {
      level: 2,
      text: parts.join("\n"),
    };
  }

  getStagedEntries(): StagedEntry[] {
    const raw = this.gitService.getStagedNameStatus().trim();

    if (!raw) return [];

    return raw
      .split("\n")
      .map((line) => this.parseNameStatusLine(line) as StagedEntry)
      .filter((entry) => entry.file);
  }

  getFileContent(ref: "HEAD" | "INDEX", file: string, status: string): string {
    if (ref === "HEAD" && status === "A") return "";
    if (ref === "INDEX" && status === "D") return "";

    const gitRef = ref === "HEAD" ? `HEAD:${file}` : `:${file}`;

    if (!this.gitService.refExists(gitRef)) {
      return "";
    }

    return this.gitService.readFileFromRef(gitRef);
  }

  isBinary(file: string): boolean {
    return this.getChangeSize(file).binary;
  }

  protected getChangeSize(file: string): ChangeSize {
    const out = this.gitService.getStagedFileNumstat(file);
    return this.parseNumstat(out);
  }
}
