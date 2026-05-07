import type { AppConfig } from "../config/config.js";
import type { BranchPRSummary } from "../types/types.js";
import type { GitService } from "./GitService.js";

export class GitPRService {
  constructor(
    private readonly git: GitService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Updates remote refs before calculating PR stats.
   * This keeps branch comparisons based on the latest remote state.
   */
  refreshRemoteBranches(): void {
    this.git.runGitOrEmpty(["fetch", "--all", "--prune"], {
      maxBuffer: this.config.git.maxBufferBytes,
    });
  }

  /**
   * Returns remote branch names that can be used as PR base branches.
   * Example: origin/main, origin/develop
   */
  getRemoteBranchNames(): string[] {
    const raw = this.git.runGitOrEmpty([
      "branch",
      "--remotes",
      "--format=%(refname:short)",
    ]);

    return raw
      .split("\n")
      .map((branch) => branch.trim())
      .filter(Boolean)
      .filter((branch) => !branch.includes("HEAD"))
      .filter((branch, index, all) => all.indexOf(branch) === index);
  }

  /**
   * Builds a short PR summary for the current branch against one base branch.
   *
   * Uses the three-dot range because that matches how PR diffs are usually reviewed:
   * compare the current branch against the merge-base with the selected base branch.
   */
  getPRSummaryForBaseBranch(baseBranch: string): BranchPRSummary {
    const commitsRaw = this.git.runGitOrEmpty([
      "log",
      "--right-only",
      "--cherry-pick",
      "--no-merges",
      "--format=%H",
      `${baseBranch}...HEAD`,
    ]);

    const shortStat = this.git.runGitOrEmpty([
      "diff",
      "--shortstat",
      `${baseBranch}...HEAD`,
    ]);

    const match = shortStat.match(
      /(?:(\d+) files? changed)?(?:,?\s*(\d+) insertions?\(\+\))?(?:,?\s*(\d+) deletions?\(-\))?/,
    );

    return {
      branch: baseBranch,
      commits: this.countLines(commitsRaw),
      files: Number(match?.[1] || 0),
      insertions: Number(match?.[2] || 0),
      deletions: Number(match?.[3] || 0),
    };
  }

  /**
   * Returns only base branches that would produce a non-empty PR.
   * Remote branches are refreshed once before summaries are calculated.
   */
  getAvailablePRBaseSummaries(): BranchPRSummary[] {
    this.refreshRemoteBranches();

    const summaries = this.getRemoteBranchNames().map((branch) =>
        this.getPRSummaryForBaseBranch(branch),
    );

    const changedSummaries = summaries.filter((summary) =>
        this.hasChanges(summary),
    );

    if (changedSummaries.length) {
        return changedSummaries;
    }

    return summaries;
  }

  private countLines(value: string): number {
    return value ? value.split("\n").filter(Boolean).length : 0;
  }

  private hasChanges(summary: BranchPRSummary): boolean {
    return (
      summary.commits > 0 ||
      summary.files > 0 ||
      summary.insertions > 0 ||
      summary.deletions > 0
    );
  }
}
