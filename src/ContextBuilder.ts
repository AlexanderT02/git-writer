import { execFileSync } from "child_process";
import type {
  CommitContext,
  FileContextResult,
  StagedEntry,
} from "./types.js";
import type { GitService } from "./GitService.js";

const TOKEN_BUDGET = 50_000;
const SMALL_FILE_THRESHOLD = 3_000;
const CONTEXT_LINES = 30;

const git = (args: string[], maxBuffer = 10 * 1024 * 1024): string => {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
  });
};

const gitExists = (ref: string): boolean => {
  try {
    execFileSync("git", ["cat-file", "-e", ref], {
      stdio: ["ignore", "ignore", "ignore"],
    });

    return true;
  } catch {
    return false;
  }
};

export class ContextBuilder {
  constructor(private readonly gitService: GitService) {}

  build(files: string): CommitContext {
    const fileList = files.split("\n").filter(Boolean);
    const fileCount = fileList.length;

    const branchCtx = this.gitService.getBranchContext();
    const stagedStats = this.gitService.getStagedStats();
    const fileHints = this.gitService.getFileTypeHints(files);
    const recentCommits = this.gitService.getRecentCommits(8);

    const stagedFileSummaries =
      fileCount > 1 ? this.gitService.getStagedFileSummaries() : "";

    const recentStyleHints =
      fileCount > 3 ? this.gitService.getRecentCommitStyleHints(12) : "";

    const fileContexts = this.buildFileContexts();

    const hasAnyTruncated = fileContexts.some((fc) => fc.level < 2);
    const changedSymbols = hasAnyTruncated
      ? this.gitService.getChangedSymbols()
      : "";

    const _diff = this.gitService.getDiff();

    return {
      ...branchCtx,
      stagedStats,
      fileHints,
      stagedFileSummaries,
      recentStyleHints,
      recentCommits,
      changedSymbols,
      fileContext: fileContexts.map((fc) => fc.text).join("\n\n"),
      _diff,
    };
  }

  buildFileContexts(): FileContextResult[] {
    const staged = this.getStagedEntries();
    let remaining = TOKEN_BUDGET;
    const results: FileContextResult[] = [];

    for (const entry of staged) {
      if (remaining <= 0) {
        results.push({
          level: -1,
          text: `[${entry.file}: skipped — budget exhausted]`,
        });
        continue;
      }

      if (this.isBinary(entry.file)) {
        results.push({
          level: -1,
          text: `=== ${entry.file} [binary] ===`,
        });
        continue;
      }

      const before = this.getFileContent("HEAD", entry.file, entry.status);
      const after = this.getFileContent("INDEX", entry.file, entry.status);
      const totalSize = before.length + after.length;

      let result: FileContextResult;

      if (totalSize <= SMALL_FILE_THRESHOLD) {
        result = this.level2(entry, before, after);
      } else if (totalSize <= remaining) {
        result = this.level2(entry, before, after);
      } else {
        const l1 = this.level1(entry);
        result = l1.text.length <= remaining ? l1 : this.level0(entry);
      }

      remaining -= result.text.length;
      results.push(result);
    }

    return results;
  }

  level0(entry: StagedEntry): FileContextResult {
    try {
      const diff = git(["diff", "--cached", "--", entry.file]);

      return {
        level: 0,
        text: `=== ${entry.file} (${entry.status}) [diff only] ===\n${diff}`,
      };
    } catch {
      return {
        level: 0,
        text: `=== ${entry.file} (${entry.status}) ===\n[no diff]`,
      };
    }
  }

  level1(entry: StagedEntry): FileContextResult {
    try {
      const diff = git([
        "diff",
        "--cached",
        `-U${CONTEXT_LINES}`,
        "--",
        entry.file,
      ]);

      return {
        level: 1,
        text: `=== ${entry.file} (${entry.status}) [diff +context] ===\n${diff}`,
      };
    } catch {
      return this.level0(entry);
    }
  }

  level2(entry: StagedEntry, before: string, after: string): FileContextResult {
    const parts = [`=== ${entry.file} (${entry.status}) [full] ===`];

    if (entry.status === "A" || !before) {
      parts.push("--- NEW FILE ---", after);
    } else if (entry.status === "D" || !after) {
      parts.push("--- DELETED FILE ---", before);
    } else {
      parts.push("--- BEFORE ---", before, "--- AFTER ---", after);
    }

    return {
      level: 2,
      text: parts.join("\n"),
    };
  }

  getStagedEntries(): StagedEntry[] {
    try {
      const raw = git(["diff", "--cached", "--name-status"]).trim();

      if (!raw) return [];

      return raw.split("\n").map((line) => {
        const parts = line.trim().split(/\s+/);
        const status = parts[0]?.[0] ?? "";
        const file = parts[parts.length - 1] ?? "";

        return { status, file };
      });
    } catch {
      return [];
    }
  }

  getFileContent(ref: "HEAD" | "INDEX", file: string, status: string): string {
    if (ref === "HEAD" && status === "A") return "";
    if (ref === "INDEX" && status === "D") return "";

    const gitRef = ref === "HEAD" ? `HEAD:${file}` : `:${file}`;

    if (!gitExists(gitRef)) {
      return "";
    }

    try {
      return git(["show", gitRef]);
    } catch {
      return "";
    }
  }

  isBinary(file: string): boolean {
    try {
      const out = git(["diff", "--cached", "--numstat", "--", file]);
      return out.startsWith("-\t-\t");
    } catch {
      return false;
    }
  }
}