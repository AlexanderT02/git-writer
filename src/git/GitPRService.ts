import type { AppConfig } from "../config/config.js";
import type { BranchPRSummary } from "../types/types.js";
import type { GitService } from "./GitService.js";

export type UnpushedCommitsInfo = {
  hasUpstream: boolean;
  branch: string;
  upstream?: string;
  count: number;
  suggestedCommand?: string;
};

export class GitPRService {
  constructor(
    private readonly git: GitService,
    private readonly config: AppConfig,
  ) {}

  refreshRemoteBranches(): void {
    this.git.runGitOrEmpty(["fetch", "--all", "--prune"], {
      maxBuffer: this.config.git.maxBufferBytes,
    });
  }

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

  getAvailablePRBaseSummaries(): BranchPRSummary[] {
    this.refreshRemoteBranches();

    const summaries = this.getRemoteBranchNames().map((branch) =>
      this.getPRSummaryForBaseBranch(branch),
    );

    const changedSummaries = summaries.filter((summary) =>
      this.hasChanges(summary),
    );

    return this.sortBaseBranches(
      changedSummaries.length ? changedSummaries : summaries,
    );
  }

  getChangedPRBaseSummaries(): BranchPRSummary[] {
    this.refreshRemoteBranches();

    return this.sortBaseBranches(
      this.getRemoteBranchNames()
        .map((branch) => this.getPRSummaryForBaseBranch(branch))
        .filter((summary) => this.hasChanges(summary)),
    );
  }

  hasPRChangesAgainst(baseBranch: string): boolean {
    return this.hasChanges(this.getPRSummaryForBaseBranch(baseBranch));
  }

  private sortBaseBranches(summaries: BranchPRSummary[]): BranchPRSummary[] {
    return [...summaries].sort((a, b) => {
      const rank = (branch: string): number => {
        if (branch === "origin/main") return 0;
        if (branch === "origin/master") return 1;
        if (branch === "origin/develop") return 2;
        return 10;
      };

      return rank(a.branch) - rank(b.branch);
    });
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

  getUnpushedCommitsInfo(): UnpushedCommitsInfo {
    const branch = this.git.runGitOrEmpty([
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);

    const upstream = this.git.runGitOrEmpty([
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);

    if (!upstream) {
      return {
        hasUpstream: false,
        branch,
        count: 0,
        suggestedCommand: `git push -u origin ${branch}`,
      };
    }

    const countRaw = this.git.runGitOrEmpty([
      "rev-list",
      "--count",
      `${upstream}..HEAD`,
    ]);

    const count = Number(countRaw || 0);

    return {
      hasUpstream: true,
      branch,
      upstream,
      count,
      suggestedCommand: count > 0 ? "git push" : undefined,
    };
  }

  pushCurrentBranch(setUpstream: boolean): void {
    const branch = this.git.runGitOrEmpty([
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);

    if (setUpstream) {
      this.git.runGit(["push", "-u", "origin", branch], {
        maxBuffer: this.config.git.maxBufferBytes,
      });
      return;
    }

    this.git.runGit(["push"], {
      maxBuffer: this.config.git.maxBufferBytes,
    });
  }
}
