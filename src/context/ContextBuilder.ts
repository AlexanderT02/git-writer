import type { AppConfig } from "../config/config.js";
import type {
  CommitContext,
  FileContextResult,
  StagedEntry,
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

    const branchCtx = this.gitService.getBranchContext();
    const stagedStats = this.gitService.getStagedStats();
    const recentCommits = this.gitService.getRecentCommits(
      this.config.git.recentCommitCount,
    );

    const stagedFileSummaries =
      fileCount > 1 ? this.gitService.getStagedFileSummaries() : "";

    const recentStyleHints =
      fileCount > 3
        ? this.gitService.getRecentCommitStyleHints(
            this.config.git.recentStyleCommitCount,
          )
        : "";

    const fileContexts = this.buildFileContexts();
    const hasAnyTruncated = fileContexts.some((ctx) => ctx.level < 2);

    const changedSymbols = hasAnyTruncated
      ? this.gitService.getChangedSymbols()
      : "";

    const _diff = this.gitService.getDiff();

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
    const diff = this.gitService.getCachedFileDiff(entry.file);

    return {
      level: 0,
      text: `=== ${entry.file} (${entry.status}) [diff only] ===\n${
        diff || "[no diff]"
      }`,
    };
  }

  level1(entry: StagedEntry): FileContextResult {
    const diff = this.gitService.getCachedFileDiffWithContext(
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
    const raw = this.gitService.getCachedNameStatus().trim();

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

    if (!this.gitService.gitRefExists(gitRef)) {
      return "";
    }

    return this.gitService.getFileFromGitRef(gitRef);
  }

  isBinary(file: string): boolean {
    const out = this.gitService.getCachedFileNumstat(file);
    return out.startsWith("-\t-\t");
  }
}