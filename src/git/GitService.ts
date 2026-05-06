import { execFileSync, spawnSync } from "child_process";
import chalk from "chalk";
import type { AppConfig } from "../config/config.js";
import type { BranchContext, CommitStats } from "../types/types.js";

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

  getStatus(): string {
    return this.runGitOrEmpty(["status", "--porcelain"], { trim: false });
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

  // Hints for prompts

  getFileTypeHints(stagedFiles: string): string {
    const files = stagedFiles
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean);

    const hints = new Set<string>();

    const extMap: Record<string, string> = {
      ".java": "Java",
      ".kt": "Kotlin",
      ".scala": "Scala",
      ".ts": "TypeScript",
      ".tsx": "TypeScript/React",
      ".js": "JavaScript",
      ".jsx": "JavaScript/React",
      ".py": "Python",
      ".go": "Go",
      ".rs": "Rust",
      ".rb": "Ruby",
      ".php": "PHP",
      ".cs": "C#",
      ".cpp": "C++",
      ".c": "C",
      ".swift": "Swift",
    };

    for (const file of files) {
      for (const [ext, lang] of Object.entries(extMap)) {
        if (file.endsWith(ext)) {
          hints.add(lang);
        }
      }

      if (/[Tt]est|[Ss]pec/.test(file)) hints.add("includes tests");
      if (/migration/i.test(file)) hints.add("includes DB migration");
      if (file.endsWith(".md") || file.endsWith(".mdx")) hints.add("includes docs");
      if (/Dockerfile|docker-compose/i.test(file)) hints.add("Docker config");
      if (/\.ya?ml$/i.test(file) && /ci|github|gitlab|pipeline/i.test(file)) {
        hints.add("CI config");
      }
      if (/pom\.xml|build\.gradle|package\.json|Cargo\.toml|go\.mod/i.test(file)) {
        hints.add("build/dep file");
      }
    }

    return [...hints].join(", ");
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
    spawnSync("git", ["commit", "-F", "-"], {
      input: message,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
    });
  }
}