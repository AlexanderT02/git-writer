import { spawnSync } from "child_process";
import type { GitService } from "./GitService.js";

export class GitHubCLIService {
  constructor(private readonly git: GitService) {}

  /**
   * Verifies that the GitHub CLI is installed and authenticated.
   * The PR creation flow depends on `gh pr create`.
   */
  ensureGitHubCliReady(): void {
    const versionResult = spawnSync("gh", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (versionResult.status !== 0) {
      throw new Error(
        "GitHub CLI is not installed or not available in PATH. Install it from: https://cli.github.com/",
      );
    }

    const authResult = spawnSync("gh", ["auth", "status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (authResult.status !== 0) {
      throw new Error(
        "GitHub CLI is installed but not authenticated. Run: gh auth login",
      );
    }
  }

  /**
   * Checks whether the current branch tracks a remote branch.
   * `gh pr create` works more reliably when the branch has already been pushed.
   */
  currentBranchHasUpstream(): boolean {
    const result = spawnSync(
      "git",
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    return result.status === 0;
  }

  /**
   * Stops PR creation if the current branch has not been pushed yet.
   */
  ensureCurrentBranchIsPushed(): void {
    if (this.currentBranchHasUpstream()) {
      return;
    }

    const branch = this.git.getCurrentBranch();

    throw new Error(
      `Current branch "${branch}" has no upstream branch. Push it first with: git push -u origin ${branch}`,
    );
  }

  /**
   * Creates a GitHub pull request from the current branch.
   * The base branch can be passed as `origin/main`; GitHub CLI expects `main`.
   */
  createPullRequestFromCurrentBranch(
    baseBranch: string,
    title: string,
    body: string,
  ): string {
    this.ensureGitHubCliReady();
    this.ensureCurrentBranchIsPushed();

    const normalizedBaseBranch = baseBranch.replace(/^origin\//, "");

    const result = spawnSync(
      "gh",
      [
        "pr",
        "create",
        "--base",
        normalizedBaseBranch,
        "--title",
        title,
        "--body",
        body,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    if (result.status !== 0) {
      throw new Error(
        result.stderr || "Failed to create pull request via GitHub CLI",
      );
    }

    return result.stdout.trim();
  }
}
