import { execFileSync, spawnSync } from "child_process";
import chalk from "chalk";
import type { AppConfig } from "../config/config.js";
import type {
  BranchContext,
  CommitStats,
  CreatedCommitSummary,
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

  stageAllFiles() {
    this.stageFiles(["."]);
  }

  runGitOrEmpty(args: string[], options: GitOptions = {}): string {
    try {
      return this.runGit(args, options);
    } catch {
      return "";
    }
  }

  getCurrentBranch(): string {
    return this.runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  getCurrentBranchContext(): BranchContext {
    const branch = this.getCurrentBranch();
    const issue = branch.match(/[/#-](\d{2,})/)?.[1];

    return {
      branch,
      issue: issue ? `#${issue}` : null,
    };
  }

  getWorkingTreeStatus(): string {
    return this.runGitOrEmpty(["status", "--porcelain=v1", "-uall"], {
      trim: false,
    });
  }

  getStagedFileNames(): string {
    return this.getStagedDiff(["--name-only"]);
  }

  getStagedShortStat(): string {
    return this.getStagedDiff(["--shortstat"]);
  }

  getStagedNameStatus(): string {
    return this.getStagedDiff(["--name-status"]);
  }

  getStagedNumstat(): string {
    return this.getStagedDiff(["--numstat"]);
  }

  getUnstagedNumstat(): string {
    return this.runGitOrEmpty(["diff", "--numstat"]);
  }

  getUnstagedNameStatus(): string {
    return this.runGitOrEmpty(["diff", "--name-status"]);
  }

  getUntrackedFiles(): string[] {
    const raw = this.runGitOrEmpty(["ls-files", "--others", "--exclude-standard"]);
    return raw ? raw.split("\n").filter(Boolean) : [];
  }

  getFileDiffHunkHeaders(file: string, staged = false): string[] {
    const args = staged
      ? ["diff", "--cached", "-U0", "--", file]
      : ["diff", "-U0", "--", file];

    const raw = this.runGitOrEmpty(args);

    return raw
      .split("\n")
      .filter((line) => line.startsWith("@@"))
      .map((line) => {
        const match = line.match(/@@.*@@\s*(.*)/);
        return match?.[1]?.trim() ?? "";
      })
      .filter(Boolean)
      .slice(0, 5);
  }

  getFileDiffKeyLines(file: string, staged = false): string[] {
    const args = staged
      ? ["diff", "--cached", "--", file]
      : ["diff", "--", file];

    const raw = this.runGitOrEmpty(args);

    return raw
      .split("\n")
      .filter(
        (line) =>
          (line.startsWith("+") || line.startsWith("-")) &&
        !line.startsWith("+++") &&
        !line.startsWith("---"),
      )
      .map((line) => line.trim())
      .filter((line) => line.length > 3)
      .filter((line) => !/^[+-]\s*[{}()[\],;]*$/.test(line))
      .filter((line) => !/^[+-]\s*(import|export)\s/.test(line))
      .filter((line) => !/^[+-]\s*\/\/\s*$/.test(line))
      .slice(0, 10);
  }

  resetStagedFiles(): void {
    this.runGitWriteCommand(["reset", "HEAD", "--quiet"], "Failed to unstage files");
  }

  getStagedFileDiff(file: string): string {
    return this.getStagedDiff(["--", file]);
  }

  getStagedFileDiffWithContext(file: string, contextLines: number): string {
    return this.getStagedDiff([`-U${contextLines}`, "--", file]);
  }

  getStagedFileNumstat(file: string): string {
    return this.getStagedDiff(["--numstat", "--", file]);
  }

  getStagedFileSummaryLines(): string {
    return this.getStagedNameStatus()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...file] = line.trim().split(/\s+/);
        return `${status}: ${file.join(" ")}`;
      })
      .join("\n");
  }

  getStagedDiffForPrompt(): string {
    const raw = this.getStagedDiff();
    const lines = raw.split("\n");

    if (lines.length <= this.config.git.largeDiffLineLimit) {
      return raw;
    }

    console.log(chalk.yellow("⚠ Large diff — semantic summary mode\n"));

    return [
      "[CHANGED FILES]",
      this.getStagedDiff(["--stat"]),
      "",
      "[CHANGED SYMBOLS & HUNKS]",
      this.getStagedDiff(["--unified=0"])
        .split("\n")
        .filter((line) => line.startsWith("+++") || line.startsWith("@@"))
        .slice(0, this.config.git.largeDiffHeaderLimit)
        .join("\n"),
    ].join("\n");
  }

  refExists(ref: string): boolean {
    try {
      this.runGit(["cat-file", "-e", ref]);
      return true;
    } catch {
      return false;
    }
  }

  readFileFromRef(ref: string): string {
    return this.runGitOrEmpty(["show", ref], {
      maxBuffer: this.config.context.maxFileBufferBytes,
    });
  }

  getRecentCommitLines(n = this.config.git.recentCommitCount): string {
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

    const types = new Set<string>();
    const scopes = new Set<string>();

    for (const line of commits.split("\n")) {
      const match = line.match(/^(\w+)(?:\(([^)]+)\))?:/);

      if (!match) continue;

      types.add(match[1] ?? "");

      if (match[2]) scopes.add(match[2]);
    }

    return [
      types.size && `Recent commit types: ${[...types].join(", ")}`,
      scopes.size &&
        `Recent scopes: ${[...scopes]
          .slice(0, this.config.git.maxRecentScopes)
          .join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  getLastCommitStats(): CommitStats | null {
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

  getChangedSymbolsFromStagedDiff(): string {
    const raw = this.getStagedDiff(["--unified=0"]);
    const symbols = new Set<string>();
    const hunkHeader = /^@@[^@]+@@\s*(.+)$/gm;

    let match: RegExpExecArray | null;

    while ((match = hunkHeader.exec(raw)) !== null) {
      const symbol = match[1]?.trim() ?? "";

      if (symbol && symbol.length < this.config.git.maxChangedSymbolLength) {
        symbols.add(symbol);
      }
    }

    return [...symbols]
      .slice(0, this.config.git.maxChangedSymbols)
      .join("\n");
  }

  stageFiles(files: string[]): void {
    this.runGitWriteCommand(["add", "--", ...files], "Failed to stage files");
  }

  createCommit(message: string): void {
    this.runGitWriteCommand(["commit", "-F", "-"], "Failed to create commit", message);
  }

  private getStagedDiff(args: string[] = []): string {
    return this.runGitOrEmpty(["diff", "--cached", ...args]);
  }

  private runGitWriteCommand(
    args: string[],
    fallbackError: string,
    input?: string,
  ): void {
    const result = spawnSync("git", args, {
      input,
      encoding: "utf8",
      stdio: input ? ["pipe", "ignore", "pipe"] : ["ignore", "pipe", "pipe"],
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || fallbackError);
    }
  }

  getCommitSummariesSince(baseSha: string): CreatedCommitSummary[] {
    const output = this.runGitOrEmpty([
      "log",
      "--reverse",
      "--pretty=format:%H%x09%s",
      `${baseSha}..HEAD`,
    ]);

    if (!output.trim()) return [];

    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", title = ""] = line.split("\t");

        return {
          sha,
          title,
          stats: this.getCommitStatsByRef(sha),
        };
      });
  }

  getCurrentHeadSha(): string {
    try {
      return this.runGit(["rev-parse", "HEAD"]).trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read current HEAD: ${message}`);
    }
  }

  resetSoftTo(ref: string): void {
    this.runGitWriteCommand(["reset", "--soft", ref], "Failed to reset commits");
  }

  private getCommitStatsByRef(ref: string): {
    files: number;
    insertions: number;
    deletions: number;
  } {
    const output = this.runGitOrEmpty([
      "show",
      "--shortstat",
      "--format=",
      ref,
    ]);

    const filesMatch = output.match(/(\d+) files? changed/);
    const insertionsMatch = output.match(/(\d+) insertions?\(\+\)/);
    const deletionsMatch = output.match(/(\d+) deletions?\(-\)/);

    return {
      files: filesMatch ? Number(filesMatch[1]) : 0,
      insertions: insertionsMatch ? Number(insertionsMatch[1]) : 0,
      deletions: deletionsMatch ? Number(deletionsMatch[1]) : 0,
    };
  }
}
