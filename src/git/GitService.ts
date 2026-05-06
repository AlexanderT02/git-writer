import { execFileSync, execSync, spawnSync } from "child_process";
import chalk from "chalk";
import type { AppConfig } from "../config/config.js";
import type { BranchContext, CommitStats } from "../types/types.js";

export class GitService {
  constructor(private readonly config: AppConfig) {}

  private git(args: string[], maxBuffer = this.config.git.maxBufferBytes): string {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  }

  getBranch(): string {
    return this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  getStatus(): string {
    return this.git(["status", "--porcelain"]);
  }

  getLastCommitSummary(): CommitStats | null {
    try {
      const output = this.git(["show", "--shortstat", "-1"]);
      const match = output.match(
        /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/,
      );

      if (!match) return null;

      return {
        files: match[1] ?? "0",
        insertions: match[2] ?? 0,
        deletions: match[3] ?? 0,
      };
    } catch {
      return null;
    }
  }

  getStagedFiles(): string {
    return this.git(["diff", "--cached", "--name-only"]);
  }

  getStagedFileSummaries(): string {
    try {
      const status = this.git(["diff", "--cached", "--name-status"]);

      if (!status) return "";

      return status
        .split("\n")
        .map((line) => {
          const [statusCode, ...rest] = line.trim().split(/\s+/);
          return `${statusCode}: ${rest.join(" ")}`;
        })
        .join("\n");
    } catch {
      return "";
    }
  }

  getStagedStats(): string {
    try {
      return this.git(["diff", "--cached", "--shortstat"]);
    } catch {
      return "";
    }
  }

  getRecentCommits(n = this.config.git.recentCommitCount): string {
    try {
      return this.git(["log", "--oneline", `-${n}`, "--no-merges"]);
    } catch {
      return "";
    }
  }

  getRecentCommitStyleHints(
    n = this.config.git.recentStyleCommitCount,
  ): string {
    try {
      const commits = this.git(["log", "--format=%s", `-${n}`, "--no-merges"]);

      if (!commits) return "";

      const scopes = new Set<string>();
      const types = new Set<string>();

      for (const line of commits.split("\n")) {
        const match = line.match(/^(\w+)(?:\(([^)]+)\))?:/);

        if (match) {
          types.add(match[1] ?? "");
          if (match[2]) scopes.add(match[2]);
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
    } catch {
      return "";
    }
  }

  getBranchContext(): BranchContext {
    const branch = this.getBranch();
    const issueMatch = branch.match(/[/#-](\d{2,})/);

    return {
      branch,
      issue: issueMatch?.[1] ? `#${issueMatch[1]}` : null,
    };
  }

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
        if (file.endsWith(ext)) hints.add(lang);
      }

      if (/[Tt]est|[Ss]pec/.test(file)) hints.add("includes tests");
      if (/migration/i.test(file)) hints.add("includes DB migration");
      if (file.endsWith(".md") || file.endsWith(".mdx")) {
        hints.add("includes docs");
      }
      if (/Dockerfile|docker-compose/i.test(file)) hints.add("Docker config");
      if (/\.ya?ml$/i.test(file) && /ci|github|gitlab|pipeline/i.test(file)) {
        hints.add("CI config");
      }
      if (
        /pom\.xml|build\.gradle|package\.json|Cargo\.toml|go\.mod/i.test(file)
      ) {
        hints.add("build/dep file");
      }
    }

    return [...hints].join(", ");
  }

  getChangedSymbols(): string {
    try {
      const raw = this.git(["diff", "--cached", "--unified=0"]);
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
    } catch {
      return "";
    }
  }

  getDiff(): string {
    const raw = this.git(["diff", "--cached"]);
    const lines = raw.split("\n");

    if (lines.length <= this.config.git.largeDiffLineLimit) {
      return raw;
    }

    console.log(chalk.yellow("⚠ Large diff — semantic summary mode\n"));

    try {
      const stat = this.git(["diff", "--cached", "--stat"]);
      const headers = this.git(["diff", "--cached", "--unified=0"])
        .split("\n")
        .filter((line) => line.startsWith("+++") || line.startsWith("@@"))
        .slice(0, this.config.git.largeDiffHeaderLimit)
        .join("\n");

      return `[CHANGED FILES]\n${stat}\n\n[CHANGED SYMBOLS & HUNKS]\n${headers}`;
    } catch {
      return this.git(["diff", "--cached", "--stat"]);
    }
  }

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
    execSync("git commit -F -", {
      input: message,
      stdio: ["pipe", "ignore", "ignore"],
    });
  }
}