import { execFileSync, spawnSync } from "child_process";
import chalk from "chalk";
import type { AppConfig } from "../config/config.js";
import type {
  BranchContext,
  CommitStats,
  BranchPRSummary,
} from "../types/types.js";

type GitOptions = {
  trim?: boolean;
  maxBuffer?: number;
};

export class GitService {
  constructor(private readonly config: AppConfig) {}

  runGit(args: string[], options: GitOptions = {}): string {
    const output = execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? this.config.git.maxBufferBytes,
      stdio: ["ignore", "pipe", "ignore"],
    });

    return options.trim === false ? output.replace(/\r?\n$/, "") : output.trim();
  }

  runGitOrEmpty(args: string[], options: GitOptions = {}): string {
    try {
      return this.runGit(args, options);
    } catch {
      return "";
    }
  }

  // Repository state

  getBranch(): string {
    return this.runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  getBranchContext(): BranchContext {
    const branch = this.getBranch();
    const issueMatch = branch.match(/[/#-](\d{2,})/);

    return {
      branch,
      issue: issueMatch?.[1] ? `#${issueMatch[1]}` : null,
    };
  }

  getDetailedStatus(): string {
    return this.runGitOrEmpty(["status", "--porcelain=v1", "-uall"], {
      trim: false,
    });
  }

  // Staged files and diffs

  getStagedFiles(): string {
    return this.runGitOrEmpty(["diff", "--cached", "--name-only"]);
  }

  getStagedStats(): string {
    return this.runGitOrEmpty(["diff", "--cached", "--shortstat"]);
  }

  getCachedNameStatus(): string {
    return this.runGitOrEmpty(["diff", "--cached", "--name-status"]);
  }

  getCachedNumstat(): string {
    return this.runGitOrEmpty(["diff", "--cached", "--numstat"]);
  }

  getWorkingTreeNumstat(): string {
    return this.runGitOrEmpty(["diff", "--numstat"]);
  }

  getCachedFileDiff(file: string): string {
    return this.runGitOrEmpty(["diff", "--cached", "--", file]);
  }

  getCachedFileDiffWithContext(file: string, contextLines: number): string {
    return this.runGitOrEmpty([
      "diff",
      "--cached",
      `-U${contextLines}`,
      "--",
      file,
    ]);
  }

  getCachedFileNumstat(file: string): string {
    return this.runGitOrEmpty(["diff", "--cached", "--numstat", "--", file]);
  }

  getStagedFileSummaries(): string {
    const status = this.getCachedNameStatus();
    if (!status) return "";

    return status
      .split("\n")
      .map((line) => {
        const [statusCode, ...rest] = line.trim().split(/\s+/);
        return `${statusCode}: ${rest.join(" ")}`;
      })
      .join("\n");
  }

  getDiff(): string {
    const raw = this.runGitOrEmpty(["diff", "--cached"]);
    const lines = raw.split("\n");

    if (lines.length <= this.config.git.largeDiffLineLimit) {
      return raw;
    }

    console.log(chalk.yellow("⚠ Large diff — semantic summary mode\n"));

    const stat = this.runGitOrEmpty(["diff", "--cached", "--stat"]);
    const headers = this.runGitOrEmpty(["diff", "--cached", "--unified=0"])
      .split("\n")
      .filter((line) => line.startsWith("+++") || line.startsWith("@@"))
      .slice(0, this.config.git.largeDiffHeaderLimit)
      .join("\n");

    return `[CHANGED FILES]\n${stat}\n\n[CHANGED SYMBOLS & HUNKS]\n${headers}`;
  }

  // Git object access

  gitRefExists(ref: string): boolean {
    try {
      this.runGit(["cat-file", "-e", ref]);
      return true;
    } catch {
      return false;
    }
  }

  getFileFromGitRef(ref: string): string {
    return this.runGitOrEmpty(["show", ref], {
      maxBuffer: this.config.context.maxFileBufferBytes,
    });
  }

  // Commit history context

  getRecentCommits(n = this.config.git.recentCommitCount): string {
    return this.runGitOrEmpty(["log", "--oneline", `-${n}`, "--no-merges"]);
  }

  getRecentCommitStyleHints(
    n = this.config.git.recentStyleCommitCount,
  ): string {
    const commits = this.runGitOrEmpty([
      "log",
      "--format=%s",
      `-${n}`,
      "--no-merges",
    ]);

    if (!commits) return "";

    const scopes = new Set<string>();
    const types = new Set<string>();

    for (const line of commits.split("\n")) {
      const match = line.match(/^(\w+)(?:\(([^)]+)\))?:/);

      if (!match) continue;

      types.add(match[1] ?? "");

      if (match[2]) {
        scopes.add(match[2]);
      }
    }

    return [
      types.size ? `Recent commit types: ${[...types].join(", ")}` : "",
      scopes.size
        ? `Recent scopes: ${[...scopes]
          .slice(0, this.config.git.maxRecentScopes)
          .join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  getLastCommitSummary(): CommitStats | null {
    const output = this.runGitOrEmpty(["show", "--shortstat", "-1"]);
    const match = output.match(
      /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/,
    );

    if (!match) return null;

    return {
      files: match[1] ?? "0",
      insertions: match[2] ?? 0,
      deletions: match[3] ?? 0,
    };
  }

  getChangedSymbols(): string {
    const raw = this.runGitOrEmpty(["diff", "--cached", "--unified=0"]);
    const symbols = new Set<string>();
    const hunkHeader = /^@@[^@]+@@\s*(.+)$/gm;

    let match: RegExpExecArray | null;

    while ((match = hunkHeader.exec(raw)) !== null) {
      const ctx = match[1]?.trim() ?? "";

      if (ctx && ctx.length < this.config.git.maxChangedSymbolLength) {
        symbols.add(ctx);
      }
    }

    return [...symbols]
      .slice(0, this.config.git.maxChangedSymbols)
      .join("\n");
  }

  getAllBranches(): string[] {
    const raw = this.runGitOrEmpty([
      "branch",
      "--all",
      "--format=%(refname:short)",
    ]);

    const current = this.getBranch();

    return raw
      .split("\n")
      .map((branch) => branch.trim())
      .filter(Boolean)
      .filter((branch) => !branch.includes("HEAD"))
      .filter((branch) => branch !== current)
      .filter((branch, index, all) => all.indexOf(branch) === index);
  }

  getBranchPRSummary(baseBranch: string): BranchPRSummary {
    const commitsRaw = this.runGitOrEmpty([
      "rev-list",
      "--count",
      `${baseBranch}..HEAD`,
    ]);

    const shortStat = this.runGitOrEmpty([
      "diff",
      "--shortstat",
      `${baseBranch}..HEAD`,
    ]);

    const match = shortStat.match(
      /(?:(\d+) files? changed)?(?:,?\s*(\d+) insertions?\(\+\))?(?:,?\s*(\d+) deletions?\(-\))?/,
    );

    return {
      branch: baseBranch,
      commits: Number(commitsRaw || 0),
      files: Number(match?.[1] || 0),
      insertions: Number(match?.[2] || 0),
      deletions: Number(match?.[3] || 0),
    };
  }

  getBranchPRSummaries(): BranchPRSummary[] {
    return this.getAllBranches()
      .map((branch) => this.getBranchPRSummary(branch))
      .filter((summary) =>
        summary.commits > 0 ||
      summary.files > 0 ||
      summary.insertions > 0 ||
      summary.deletions > 0,
      );
  }

  // Mutations

  add(files: string[]): void {
    const result = spawnSync("git", ["add", "--", ...files], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || "Failed to stage files");
    }
  }

  commit(message: string): void {
    const result = spawnSync("git", ["commit", "-F", "-"], {
      input: message,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || "Failed to create commit");
    }
  }
}
