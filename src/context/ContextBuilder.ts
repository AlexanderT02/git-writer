import type { AppConfig } from "../config/config.js";
import type {
  CommitContext,
  FileContextResult,
  StagedEntry,
  PRContext,
} from "../types/types.js";
import type { GitService } from "../git/GitService.js";

export class ContextBuilder {
  constructor(
    private readonly gitService: GitService,
    private readonly config: AppConfig,
  ) {}

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
    const hasAnyTruncated = fileContexts.some((ctx) => ctx.level < 2);

    const changedSymbols = hasAnyTruncated
      ? this.gitService.getChangedSymbolsFromStagedDiff()
      : "";

    const _diff = this.gitService.getStagedDiffForPrompt();

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
    const staged = this.getStagedEntries();
    let remaining = this.config.context.tokenBudget;
    const results: FileContextResult[] = [];

    for (const entry of staged) {
      if (remaining <= 0) {
        results.push(this.skipped(entry));
        continue;
      }

      if (this.isBinary(entry.file)) {
        results.push(this.binary(entry));
        continue;
      }

      const result = this.buildSingleFileContext(entry, remaining);

      remaining -= result.text.length;
      results.push(result);
    }

    return results;
  }

  private buildSingleFileContext(
    entry: StagedEntry,
    remaining: number,
  ): FileContextResult {
    if (entry.status === "D") {
      return this.deleted(entry);
    }

    const before = this.getFileContent("HEAD", entry.file, entry.status);
    const after = this.getFileContent("INDEX", entry.file, entry.status);
    const totalSize = before.length + after.length;

    if (
      totalSize <= this.config.context.smallFileThreshold ||
      totalSize <= remaining
    ) {
      return this.level2(entry, before, after);
    }

    const level1 = this.level1(entry);
    return level1.text.length <= remaining ? level1 : this.level0(entry);
  }

  private skipped(entry: StagedEntry): FileContextResult {
    return {
      level: -1,
      text: `[${entry.file}: skipped — budget exhausted]`,
    };
  }

  private binary(entry: StagedEntry): FileContextResult {
    return {
      level: -1,
      text: `=== ${entry.file} (${entry.status}) [binary] ===`,
    };
  }

  private deleted(entry: StagedEntry): FileContextResult {
    return {
      level: 2,
      text: `=== ${entry.file} (${entry.status}) [deleted] ===\n--- DELETED FILE ---`,
    };
  }

  level0(entry: StagedEntry): FileContextResult {
    const diff = this.gitService.getStagedFileDiff(entry.file);

    return {
      level: 0,
      text: `=== ${entry.file} (${entry.status}) [diff only] ===\n${
        diff || "[no diff]"
      }`,
    };
  }

  level1(entry: StagedEntry): FileContextResult {
    const diff = this.gitService.getStagedFileDiffWithContext(
      entry.file,
      this.config.context.contextLines,
    );

    return diff
      ? {
        level: 1,
        text: `=== ${entry.file} (${entry.status}) [diff +context] ===\n${diff}`,
      }
      : this.level0(entry);
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

    return raw.split("\n").map((line) => {
      const parts = line.trim().split(/\s+/);
      const status = parts[0]?.[0] ?? "";
      const file = parts[parts.length - 1] ?? "";

      return { status, file };
    });
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
    const out = this.gitService.getStagedFileNumstat(file);
    return out.startsWith("-\t-\t");
  }

  buildPRContext(baseBranch: string = "origin/main"): PRContext {
    const branchCtx = this.gitService.getCurrentBranchContext();

    const commits = this.gitService.runGitOrEmpty([
      "log",
      "--right-only",
      "--cherry-pick",
      "--oneline",
      "--no-merges",
      `${baseBranch}...HEAD`,
    ]);

    const diff = this.gitService.runGitOrEmpty([
      "diff",
      `${baseBranch}...HEAD`,
    ]);

    const changedFiles = this.gitService.runGitOrEmpty([
      "diff",
      "--name-status",
      `${baseBranch}...HEAD`,
    ]);

    const fileContexts = changedFiles
      .split("\n")
      .filter(Boolean)
      .map((line) => this.buildPRFileContext(baseBranch, line));

    return {
      branch: branchCtx.branch,
      issue: branchCtx.issue,
      commits,
      diff,
      fileContexts: fileContexts.filter(Boolean).join("\n\n"),
    };
  }
  private buildPRFileContext(baseBranch: string, line: string): string {
    const parts = line.trim().split(/\s+/);
    const status = parts[0]?.[0] ?? "";
    const file = parts[parts.length - 1] ?? "";

    if (!file) return "";

    if (status === "D") {
      return `=== ${file} (${status}) [deleted] ===\n--- DELETED FILE ---`;
    }

    const diff = this.gitService.runGitOrEmpty([
      "diff",
      `${baseBranch}...HEAD`,
      "--",
      file,
    ]);

    if (!diff) {
      return `=== ${file} (${status}) [changed] ===\n[no diff]`;
    }

    const lines = diff.split("\n");

    if (lines.length <= this.config.git.largeDiffLineLimit) {
      return `=== ${file} (${status}) [diff] ===\n${diff}`;
    }

    const compactDiff = this.gitService.runGitOrEmpty([
      "diff",
      `${baseBranch}...HEAD`,
      `-U${this.config.context.contextLines}`,
      "--",
      file,
    ]);

    return `=== ${file} (${status}) [diff +context] ===\n${compactDiff || diff}`;
  }
}
