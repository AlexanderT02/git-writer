import { execSync, spawnSync } from "child_process";
import chalk from "chalk";
import type { BranchContext, CommitStats } from "./types.js";

export class GitService {
  getBranch(): string {
    return execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
  }

  getStatus(): string {
    return execSync("git status --porcelain").toString().trim();
  }

  getLastCommitSummary(): CommitStats | null {
    try {
      const output = execSync("git show --shortstat -1").toString().trim();
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
    return execSync("git diff --cached --name-only").toString().trim();
  }

  getStagedFileSummaries(): string {
    try {
      const status = execSync("git diff --cached --name-status")
        .toString()
        .trim();

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
      return execSync("git diff --cached --shortstat").toString().trim();
    } catch {
      return "";
    }
  }

  getRecentCommits(n = 8): string {
    try {
      return execSync(`git log --oneline -${n} --no-merges`).toString().trim();
    } catch {
      return "";
    }
  }

  getRecentCommitStyleHints(n = 12): string {
    try {
      const commits = execSync(`git log --format=%s -${n} --no-merges`)
        .toString()
        .trim();

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
          ? `Recent scopes: ${[...scopes].slice(0, 10).join(", ")}`
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
      const raw = execSync("git diff --cached --unified=0").toString();
      const symbols = new Set<string>();
      const hunkHeader = /^@@[^@]+@@\s*(.+)$/gm;
      let match: RegExpExecArray | null;

      while ((match = hunkHeader.exec(raw)) !== null) {
        const ctx = match[1]?.trim() ?? "";
        if (ctx && ctx.length < 120) symbols.add(ctx);
      }

      return [...symbols].slice(0, 30).join("\n");
    } catch {
      return "";
    }
  }

  getDiff(): string {
    const raw = execSync("git diff --cached").toString();
    const lines = raw.split("\n");

    if (lines.length <= 800) return raw;

    console.log(chalk.yellow("⚠ Large diff — semantic summary mode\n"));

    try {
      const stat = execSync("git diff --cached --stat").toString().trim();
      const headers = execSync("git diff --cached --unified=0")
        .toString()
        .split("\n")
        .filter((line) => line.startsWith("+++") || line.startsWith("@@"))
        .slice(0, 150)
        .join("\n");

      return `[CHANGED FILES]\n${stat}\n\n[CHANGED SYMBOLS & HUNKS]\n${headers}`;
    } catch {
      return execSync("git diff --cached --stat").toString();
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