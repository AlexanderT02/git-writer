import { spawnSync } from "child_process";
import type { GitService } from "./GitService.js";
import type {
  ExistingPullRequest,
  PullRequestCreateResult,
  PullRequestUpdateResult,
} from "../types/Types.js";
export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export class GitHubCLIService {
  private static readonly CONTEXT_HEAD_RE =
    /<!--\s*gw-context-head:\s*([0-9a-f]{7,40})\s*-->/i;

  constructor(private readonly git: GitService) {}

  private run(command: string, args: string[]): CommandResult {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    return {
      status: result.status,
      stdout: result.stdout?.trim() ?? "",
      stderr: result.stderr?.trim() ?? "",
    };
  }

  normalizeBaseBranch(baseBranch: string): string {
    return baseBranch.replace(/^origin\//, "");
  }

  private extractUrl(text: string): string | null {
    return text.match(/https:\/\/github\.com\/[^\s]+/)?.[0] ?? null;
  }

  extractContextHeadSha(body: string): string | undefined {
    return body.match(GitHubCLIService.CONTEXT_HEAD_RE)?.[1];
  }

  isGitHubCliInstalled(): boolean {
    return this.run("gh", ["--version"]).status === 0;
  }

  isGitHubCliAuthenticated(): boolean {
    return this.run("gh", ["auth", "status"]).status === 0;
  }

  getReadinessError(): PullRequestCreateResult | null {
    if (!this.isGitHubCliInstalled()) {
      return {
        status: "gh_missing",
        message:
          "GitHub CLI is not installed or not available in PATH. Install it from https://cli.github.com/.",
      };
    }

    if (!this.isGitHubCliAuthenticated()) {
      return {
        status: "gh_unauthenticated",
        message: "GitHub CLI is installed but not authenticated.",
        suggestedCommand: "gh auth login",
      };
    }

    return null;
  }

  currentBranchHasUpstream(): boolean {
    return (
      this.run("git", [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{u}",
      ]).status === 0
    );
  }

  currentBranchIsPushed(): boolean {
    const result = this.run("git", ["status", "--porcelain=v1", "--branch"]);

    if (result.status !== 0) return false;

    const firstLine = result.stdout.split("\n")[0] ?? "";

    return !firstLine.includes("[ahead ");
  }

  getCurrentBranchUpstreamError(): PullRequestCreateResult | null {
    if (!this.currentBranchHasUpstream()) {
      const branch = this.git.getCurrentBranch();

      return {
        status: "not_pushed",
        message: `Current branch "${branch}" has no upstream branch.`,
        suggestedCommand: `git push -u origin ${branch}`,
      };
    }

    if (!this.currentBranchIsPushed()) {
      return {
        status: "unpushed_commits",
        message: "Current branch has local commits that are not pushed.",
        suggestedCommand: "git push",
      };
    }

    return null;
  }

  getExistingPullRequestUrl(baseBranch: string): string | null {
    return this.getExistingPullRequest(baseBranch)?.url ?? null;
  }

  getExistingPullRequest(baseBranch: string): ExistingPullRequest | null {
    const normalizedBaseBranch = this.normalizeBaseBranch(baseBranch);
    const currentBranch = this.git.getCurrentBranch();

    const result = this.run("gh", [
      "pr",
      "list",
      "--state",
      "open",
      "--head",
      currentBranch,
      "--base",
      normalizedBaseBranch,
      "--json",
      "url,title,body",
      "--limit",
      "1",
    ]);

    if (result.status !== 0 || !result.stdout) {
      return null;
    }

    try {
      const parsedList = JSON.parse(result.stdout) as Array<Partial<ExistingPullRequest>>;
      const parsed = parsedList[0];

      if (!parsed || !parsed.url || !parsed.title) {
        return null;
      }

      return {
        url: parsed.url,
        title: parsed.title,
        body: parsed.body ?? "",
        contextHeadSha: this.extractContextHeadSha(parsed.body ?? ""),
      };
    } catch {
      return null;
    }
  }

  getPreflightError(baseBranch: string): PullRequestCreateResult | null {
    const readinessError = this.getReadinessError();

    if (readinessError) {
      return readinessError;
    }

    const upstreamError = this.getCurrentBranchUpstreamError();

    if (upstreamError) {
      return upstreamError;
    }

    const existingPrUrl = this.getExistingPullRequestUrl(baseBranch);

    if (existingPrUrl) {
      return {
        status: "already_exists",
        url: existingPrUrl,
        message: "A pull request for the current branch already exists.",
      };
    }

    return null;
  }

  createPullRequestFromCurrentBranch(
    baseBranch: string,
    title: string,
    body: string,
  ): PullRequestCreateResult {
    const preflightError = this.getPreflightError(baseBranch);

    if (preflightError) {
      return preflightError;
    }

    const normalizedBaseBranch = this.normalizeBaseBranch(baseBranch);

    const result = this.run("gh", [
      "pr",
      "create",
      "--base",
      normalizedBaseBranch,
      "--title",
      title,
      "--body",
      body,
    ]);

    if (result.status === 0) {
      return {
        message: "Pull request created successfully.",
        status: "created",
        url: result.stdout,
      };
    }

    const combinedOutput = [result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n");

    const existingPrUrl = this.extractUrl(combinedOutput);

    if (
      /pull request .* already exists/i.test(combinedOutput) ||
      /already exists/i.test(combinedOutput)
    ) {
      return {
        status: "already_exists",
        url: existingPrUrl,
        message: combinedOutput,
      };
    }

    return {
      status: "failed",
      message: combinedOutput || "Failed to create pull request via GitHub CLI.",
    };
  }

  updatePullRequestFromCurrentBranch(
    baseBranch: string,
    title: string,
    body: string,
  ): PullRequestUpdateResult {
    const readinessError = this.getReadinessError();

    if (readinessError) {
      if (readinessError.status === "gh_missing") {
        return readinessError;
      }

      if (readinessError.status === "gh_unauthenticated") {
        return readinessError;
      }
    }

    const upstreamError = this.getCurrentBranchUpstreamError();

    if (upstreamError) {
      if (upstreamError.status === "not_pushed") {
        return upstreamError;
      }

      if (upstreamError.status === "unpushed_commits") {
        return upstreamError;
      }
    }

    const existingPrUrl = this.getExistingPullRequestUrl(baseBranch);

    if (!existingPrUrl) {
      return {
        status: "not_found",
        message:
          "No existing pull request found for the current branch and selected base branch.",
      };
    }

    const result = this.run("gh", [
      "pr",
      "edit",
      existingPrUrl,
      "--title",
      title,
      "--body",
      body,
    ]);

    if (result.status === 0) {
      return {
        status: "updated",
        url: existingPrUrl,
        message: "Pull request updated successfully.",
      };
    }

    const combinedOutput = [result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n");

    if (/not found|no pull requests found/i.test(combinedOutput)) {
      return {
        status: "not_found",
        message: combinedOutput,
      };
    }

    return {
      status: "failed",
      message: combinedOutput || "Failed to update pull request via GitHub CLI.",
    };
  }
}
