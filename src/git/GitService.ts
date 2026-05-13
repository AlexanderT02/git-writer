import { execFileSync, spawnSync } from "child_process";
import chalk from "chalk";
import type { AppConfig } from "../config/config.js";
import type { BranchContext, CommitStats } from "../types/types.js";

type GitOptions = {
  trim?: boolean;
  maxBuffer?: number;
};

/**
 * Central Git CLI adapter for reading repository state and performing writes.
 *
 * Notes:
 * - uses execFileSync/spawnSync without a shell
 * - disables interactive Git credential prompts
 * - supports unborn HEAD repositories before the first commit
 * - filters non-stageable paths before running git add
 */
export class GitService {
  constructor(private readonly config: AppConfig) {}

  runGit(args: string[], options: GitOptions = {}): string {
    const output = execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? this.config.git.maxBufferBytes,
      stdio: ["ignore", "pipe", "ignore"],
      env: this.gitEnv(),
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

  stageAllFiles(): void {
    this.stageFiles(["."]);
  }

  getCurrentBranch(): string {
    return (
      this.runGitOrEmpty(["symbolic-ref", "--short", "HEAD"]) ||
      this.runGitOrEmpty(["rev-parse", "--abbrev-ref", "HEAD"]) ||
      "HEAD"
    );
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
    return this.lines(
      this.runGitOrEmpty(["ls-files", "--others", "--exclude-standard"]),
    );
  }

  getFileDiffHunkHeaders(file: string, staged = false): string[] {
    return this.lines(this.getFileDiff(file, staged, ["-U0"]))
      .filter((line) => line.startsWith("@@"))
      .map((line) => line.match(/@@.*@@\s*(.*)/)?.[1]?.trim() ?? "")
      .filter(Boolean)
      .slice(0, 5);
  }

  getFileDiffKeyLines(file: string, staged = false): string[] {
    return this.lines(this.getFileDiff(file, staged))
      .filter(
        (line) =>
          /^[+-]/.test(line) &&
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

  hasCommits(): boolean {
    return this.gitHasOutput(["rev-parse", "--verify", "HEAD"]);
  }

  hasStagedFiles(): boolean {
    return Boolean(this.runGitOrEmpty(["diff", "--cached", "--name-only"]));
  }

  resetStagedFiles(): void {
    if (!this.hasStagedFiles()) return;

    this.runGitWriteCommand(
      this.hasCommits()
        ? ["reset", "HEAD", "--quiet"]
        : ["rm", "--cached", "-r", "--quiet", "--", "."],
      "Failed to unstage files",
    );
  }

  unstageFiles(files: string[]): void {
    const indexedFiles = files.filter((file) =>
      this.gitHasOutput(["ls-files", "--cached", "--", file]),
    );

    if (indexedFiles.length === 0) return;

    this.runGitWriteCommand(
      this.hasCommits()
        ? ["reset", "HEAD", "--quiet", "--", ...indexedFiles]
        : ["rm", "--cached", "--quiet", "--", ...indexedFiles],
      "Failed to unstage files",
    );
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
    return this.lines(this.getStagedNameStatus())
      .map((line) => {
        const [status, ...file] = line.trim().split(/\s+/);
        return `${status}: ${file.join(" ")}`;
      })
      .join("\n");
  }

  getStagedDiffForPrompt(): string {
    const raw = this.getStagedDiff();

    if (this.lines(raw).length <= this.config.git.largeDiffLineLimit) {
      return raw;
    }

    console.log(chalk.yellow("⚠ Large diff — semantic summary mode\n"));

    return [
      "[CHANGED FILES]",
      this.getStagedDiff(["--stat"]),
      "",
      "[CHANGED SYMBOLS & HUNKS]",
      this.lines(this.getStagedDiff(["--unified=0"]))
        .filter((line) => line.startsWith("+++") || line.startsWith("@@"))
        .slice(0, this.config.git.largeDiffHeaderLimit)
        .join("\n"),
    ].join("\n");
  }

  refExists(ref: string): boolean {
    return this.gitExitCodeIsZero(["cat-file", "-e", ref]);
  }

  readFileFromRef(ref: string): string {
    return this.runGitOrEmpty(["show", ref], {
      maxBuffer: this.config.context.maxFileBufferBytes,
    });
  }

  getRecentCommitLines(n = this.config.git.recentCommitCount): string {
    return this.runGitOrEmpty(["log", "--oneline", `-${n}`, "--no-merges"]);
  }

  getRecentCommitStyleHints(n = this.config.git.recentStyleCommitCount): string {
    const commits = this.runGitOrEmpty([
      "log",
      "--format=%s",
      `-${n}`,
      "--no-merges",
    ]);

    const types = new Set<string>();
    const scopes = new Set<string>();

    for (const line of this.lines(commits)) {
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
    const symbols = new Set<string>();
    const hunkHeader = /^@@[^@]+@@\s*(.+)$/gm;
    const raw = this.getStagedDiff(["--unified=0"]);

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
    const stageableFiles = files.filter((file) => this.isStageablePath(file));
    if (stageableFiles.length === 0) return;

    this.runGitWriteCommand(
      ["add", "--", ...stageableFiles],
      "Failed to stage files",
    );
  }

  createCommit(message: string): void {
    this.runGitWriteCommand(
      ["commit", "-F", "-"],
      "Failed to create commit",
      message,
    );
  }

  private getStagedDiff(args: string[] = []): string {
    return this.runGitOrEmpty([...this.stagedDiffBaseArgs(), ...args]);
  }

  private stagedDiffBaseArgs(): string[] {
    return this.hasCommits()
      ? ["diff", "--cached"]
      : ["diff", "--cached", "--root"];
  }

  private getFileDiff(file: string, staged: boolean, extraArgs: string[] = []): string {
    return this.runGitOrEmpty([
      "diff",
      ...(staged ? ["--cached"] : []),
      ...extraArgs,
      "--",
      file,
    ]);
  }

  private isStageablePath(file: string): boolean {
    return (
      this.gitHasOutput(["ls-files", "--error-unmatch", "--", file]) ||
      Boolean(
        this.runGitOrEmpty([
          "ls-files",
          "--others",
          "--exclude-standard",
          "--",
          file,
        ]),
      )
    );
  }

  private gitHasOutput(args: string[]): boolean {
    return Boolean(this.runGitOrEmpty(args));
  }

  private gitExitCodeIsZero(args: string[]): boolean {
    try {
      this.runGit(args);
      return true;
    } catch {
      return false;
    }
  }

  private lines(value: string): string[] {
    return value.split("\n").filter(Boolean);
  }

  private gitEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    };
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
      env: this.gitEnv(),
    });

    if (result.error) {
      throw new Error(`${fallbackError}: ${result.error.message}`);
    }

    if (result.status !== 0) {
      const stderr = result.stderr?.trim();
      throw new Error(stderr ? `${fallbackError}: ${stderr}` : fallbackError);
    }
  }
}
