import { execSync } from "child_process";

/**
 * Builds commit context using a per-file zoom-out strategy.
 *
 * Small files get full before/after context.
 * Larger files get the richest context that still fits the budget.
 */

const TOKEN_BUDGET = 50_000; // Rough character budget for all generated context.
const SMALL_FILE_THRESHOLD = 3_000; // Files below this size always get full context.
const CONTEXT_LINES = 30; // Extra lines around each diff hunk for level 1.

export class ContextBuilder {
  constructor(git) {
    this.git = git;
  }

  build(files) {
    const fileList = files.split("\n").filter(Boolean);
    const fileCount = fileList.length;

    // Cheap, high-value context that is useful for almost every commit.
    const branchCtx = this.git.getBranchContext();
    const stagedStats = this.git.getStagedStats();
    const fileHints = this.git.getFileTypeHints(files);
    const recentCommits = this.git.getRecentCommits(8);

    // Only include broader summaries when multiple files are involved.
    const stagedFileSummaries =
      fileCount > 1 ? this.git.getStagedFileSummaries() : "";

    // Commit style hints are only worth the extra context for larger changes.
    const recentStyleHints =
      fileCount > 3 ? this.git.getRecentCommitStyleHints(12) : "";

    const fileContexts = this.buildFileContexts(fileList);

    // Symbol hints are only useful when at least one file was truncated.
    const hasAnyTruncated = fileContexts.some((fc) => fc.level < 2);
    const changedSymbols = hasAnyTruncated
      ? this.git.getChangedSymbols()
      : "";

    // Keep the raw diff available for downstream checks such as breaking-change detection.
    const _diff = this.git.getDiff();

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

  buildFileContexts(fileList) {
    const staged = this.getStagedEntries();
    let remaining = TOKEN_BUDGET;
    const results = [];

    for (const entry of staged) {
      if (remaining <= 0) {
        results.push({
          level: -1,
          text: `[${entry.file}: skipped — budget exhausted]`,
        });
        continue;
      }

      // Binary files cannot provide useful text context.
      if (this.isBinary(entry.file)) {
        results.push({ level: -1, text: `=== ${entry.file} [binary] ===` });
        continue;
      }

      const before = this.getFileContent("HEAD", entry.file, entry.status);
      const after = this.getFileContent("INDEX", entry.file, entry.status);
      const totalSize = before.length + after.length;

      let result;

      if (totalSize <= SMALL_FILE_THRESHOLD) {
        result = this.level2(entry, before, after);
      } else if (totalSize <= remaining) {
        result = this.level2(entry, before, after);
      } else {
        // Fall back from full file context to expanded diff, then to plain diff.
        const l1 = this.level1(entry);

        if (l1.text.length <= remaining) {
          result = l1;
        } else {
          result = this.level0(entry);
        }
      }

      remaining -= result.text.length;
      results.push(result);
    }

    return results;
  }

  level0(entry) {
    try {
      const diff = execSync(
        `git diff --cached -- "${entry.file}"`,
      ).toString();

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

  level1(entry) {
    try {
      const diff = execSync(
        `git diff --cached -U${CONTEXT_LINES} -- "${entry.file}"`,
      ).toString();

      return {
        level: 1,
        text: `=== ${entry.file} (${entry.status}) [diff +context] ===\n${diff}`,
      };
    } catch {
      return this.level0(entry);
    }
  }

  level2(entry, before, after) {
    const parts = [`=== ${entry.file} (${entry.status}) [full] ===`];

    if (entry.status === "A") {
      parts.push(`--- NEW FILE ---`);
      parts.push(after);
    } else if (entry.status === "D") {
      parts.push(`--- DELETED FILE ---`);
      parts.push(before);
    } else {
      parts.push(`--- BEFORE ---`);
      parts.push(before);
      parts.push(`--- AFTER ---`);
      parts.push(after);
    }

    return { level: 2, text: parts.join("\n") };
  }

  getStagedEntries() {
    try {
      const raw = execSync("git diff --cached --name-status")
        .toString()
        .trim();

      if (!raw) return [];

      return raw.split("\n").map((line) => {
        const parts = line.trim().split(/\s+/);

        return {
          status: parts[0][0], // Normalize R100 to R.
          file: parts[parts.length - 1],
        };
      });
    } catch {
      return [];
    }
  }

  getFileContent(ref, file, status) {
    if (ref === "HEAD" && status === "A") return "";
    if (ref === "INDEX" && status === "D") return "";

    const gitRef = ref === "HEAD" ? `HEAD:"${file}"` : `:"${file}"`;

    try {
      return execSync(`git show ${gitRef}`, {
        maxBuffer: 10 * 1024 * 1024,
      }).toString();
    } catch {
      return "";
    }
  }

  isBinary(file) {
    try {
      const out = execSync(
        `git diff --cached --numstat -- "${file}"`,
      ).toString();

      return out.startsWith("-\t-\t");
    } catch {
      return false;
    }
  }
}