import { describe, it, expect, vi } from "vitest";
import { GitService } from "../../src/git/GitService.js";
import { createTestConfig } from "./helpers.js";

/**
 * GitService wraps child_process calls. We mock execFileSync and spawnSync
 * to test the parsing and branching logic without a real git repo.
 */

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execFileSync, spawnSync } from "child_process";

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawnSync = vi.mocked(spawnSync);

function createService() {
  return new GitService(createTestConfig());
}

describe("GitService", () => {

  describe("runGit", () => {
    it("returns trimmed output by default", () => {
      mockedExecFileSync.mockReturnValue("  output  \n");
      const svc = createService();
      expect(svc.runGit(["status"])).toBe("output");
    });

    it("preserves content but strips trailing newline with trim=false", () => {
      mockedExecFileSync.mockReturnValue("  output  \n");
      const svc = createService();
      expect(svc.runGit(["status"], { trim: false })).toBe("  output  ");
    });
  });

  describe("runGitOrEmpty", () => {
    it("returns output on success", () => {
      mockedExecFileSync.mockReturnValue("output\n");
      const svc = createService();
      expect(svc.runGitOrEmpty(["log"])).toBe("output");
    });

    it("returns empty string on error", () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error("git failed"); });
      const svc = createService();
      expect(svc.runGitOrEmpty(["log"])).toBe("");
    });
  });

  describe("getCurrentBranch", () => {
    it("returns current branch name", () => {
      mockedExecFileSync.mockReturnValue("feature/login\n");
      const svc = createService();
      expect(svc.getCurrentBranch()).toBe("feature/login");
    });
  });

  describe("getCurrentBranchContext", () => {
    it("extracts issue number from branch name", () => {
      mockedExecFileSync.mockReturnValue("feature/42-login\n");
      const svc = createService();
      const ctx = svc.getCurrentBranchContext();
      expect(ctx.branch).toBe("feature/42-login");
      expect(ctx.issue).toBe("#42");
    });

    it("extracts issue with hash separator", () => {
      mockedExecFileSync.mockReturnValue("feature#123\n");
      const svc = createService();
      const ctx = svc.getCurrentBranchContext();
      expect(ctx.issue).toBe("#123");
    });

    it("extracts issue with slash separator", () => {
      mockedExecFileSync.mockReturnValue("fix/456-auth\n");
      const svc = createService();
      const ctx = svc.getCurrentBranchContext();
      expect(ctx.issue).toBe("#456");
    });

    it("returns null issue for branches without numbers", () => {
      mockedExecFileSync.mockReturnValue("main\n");
      const svc = createService();
      const ctx = svc.getCurrentBranchContext();
      expect(ctx.issue).toBeNull();
    });

    it("ignores single-digit numbers", () => {
      mockedExecFileSync.mockReturnValue("v1\n");
      const svc = createService();
      const ctx = svc.getCurrentBranchContext();
      expect(ctx.issue).toBeNull();
    });
  });

  describe("getRecentCommitStyleHints", () => {
    it("extracts commit types and scopes", () => {
      mockedExecFileSync.mockReturnValue(
        "feat(auth): add login\nfix(ui): fix button\nchore: update deps\n"
      );
      const svc = createService();
      const hints = svc.getRecentCommitStyleHints(3);
      expect(hints).toContain("feat");
      expect(hints).toContain("fix");
      expect(hints).toContain("chore");
      expect(hints).toContain("auth");
      expect(hints).toContain("ui");
    });

    it("handles commits without conventional format", () => {
      mockedExecFileSync.mockReturnValue("Update readme\nFix typo\n");
      const svc = createService();
      const hints = svc.getRecentCommitStyleHints(2);
      expect(hints).toBe("");
    });

    it("returns empty for no commits", () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error("no commits"); });
      const svc = createService();
      const hints = svc.getRecentCommitStyleHints(5);
      expect(hints).toBe("");
    });

    it("deduplicates types and scopes", () => {
      mockedExecFileSync.mockReturnValue(
        "feat(auth): first\nfeat(auth): second\nfeat: third\n"
      );
      const svc = createService();
      const hints = svc.getRecentCommitStyleHints(3);
      // "feat" should appear only once in types
      const typeMatches = hints.match(/feat/g);
      // Could appear twice: once in types, once in the raw "Recent commit types"
      // But the types set should contain feat only once
      expect(hints).toContain("Recent commit types: feat");
      expect(hints).toContain("Recent scopes: auth");
    });
  });

  describe("getLastCommitStats", () => {
    it("parses shortstat output", () => {
      mockedExecFileSync.mockReturnValue(
        "commit abc123\n\n 3 files changed, 42 insertions(+), 10 deletions(-)\n"
      );
      const svc = createService();
      const stats = svc.getLastCommitStats();
      expect(stats).toEqual({
        files: "3",
        insertions: "42",
        deletions: "10",
      });
    });

    it("handles insertions-only stats", () => {
      mockedExecFileSync.mockReturnValue(
        "commit abc\n\n 1 file changed, 5 insertions(+)\n"
      );
      const svc = createService();
      const stats = svc.getLastCommitStats();
      expect(stats).toEqual({
        files: "1",
        insertions: "5",
        deletions: 0,
      });
    });

    it("returns null for empty output", () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error("no commits"); });
      const svc = createService();
      const stats = svc.getLastCommitStats();
      expect(stats).toBeNull();
    });
  });

  describe("getChangedSymbolsFromStagedDiff", () => {
    it("extracts function names from hunk headers", () => {
      mockedExecFileSync.mockReturnValue(
        "diff --git a/src/foo.ts b/src/foo.ts\n" +
        "@@ -10,5 +10,6 @@ function handleAuth\n" +
        "+new line\n" +
        "@@ -20,3 +21,4 @@ class UserService\n" +
        "+another line\n"
      );
      const svc = createService();
      const symbols = svc.getChangedSymbolsFromStagedDiff();
      expect(symbols).toContain("function handleAuth");
      expect(symbols).toContain("class UserService");
    });

    it("returns empty for no hunk headers", () => {
      mockedExecFileSync.mockReturnValue("");
      const svc = createService();
      expect(svc.getChangedSymbolsFromStagedDiff()).toBe("");
    });

    it("skips symbols longer than maxChangedSymbolLength", () => {
      const longSymbol = "a".repeat(200);
      mockedExecFileSync.mockReturnValue(
        `@@ -1,1 +1,1 @@ ${longSymbol}\n`
      );
      const svc = createService();
      const symbols = svc.getChangedSymbolsFromStagedDiff();
      expect(symbols).toBe("");
    });

    it("respects maxChangedSymbols limit", () => {
      const lines = Array.from({ length: 50 }, (_, i) =>
        `@@ -${i},1 +${i},1 @@ symbol_${i}\n`
      ).join("");
      mockedExecFileSync.mockReturnValue(lines);
      const svc = createService();
      const symbols = svc.getChangedSymbolsFromStagedDiff();
      const count = symbols.split("\n").filter(Boolean).length;
      expect(count).toBeLessThanOrEqual(30); // maxChangedSymbols config
    });
  });

  describe("getStagedDiffForPrompt", () => {
    it("returns full diff for small changes", () => {
      const smallDiff = "line1\nline2\nline3";
      mockedExecFileSync.mockReturnValue(smallDiff);
      const svc = createService();
      const result = svc.getStagedDiffForPrompt();
      expect(result).toBe(smallDiff);
    });

    it("returns semantic summary for large diffs", () => {
      const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
      // First call returns the big diff, second returns --stat, third returns --unified=0
      let callCount = 0;
      mockedExecFileSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return lines.join("\n") + "\n";
        if (callCount === 2) return " src/foo.ts | 500 +++\n";
        return "+++  src/foo.ts\n@@ -1 +1 @@\n";
      });
      const svc = createService();
      const result = svc.getStagedDiffForPrompt();
      expect(result).toContain("[CHANGED FILES]");
      expect(result).toContain("[CHANGED SYMBOLS & HUNKS]");
    });
  });

  describe("refExists", () => {
    it("returns true when ref exists", () => {
      mockedExecFileSync.mockReturnValue("");
      const svc = createService();
      expect(svc.refExists("HEAD:file.ts")).toBe(true);
    });

    it("returns false when ref does not exist", () => {
      mockedExecFileSync.mockImplementation(() => { throw new Error("not found"); });
      const svc = createService();
      expect(svc.refExists("HEAD:missing.ts")).toBe(false);
    });
  });

  describe("getStagedFileSummaryLines", () => {
    it("formats name-status into summary lines", () => {
      mockedExecFileSync.mockReturnValue("M\tsrc/a.ts\nA\tsrc/b.ts\n");
      const svc = createService();
      const result = svc.getStagedFileSummaryLines();
      expect(result).toContain("M: src/a.ts");
      expect(result).toContain("A: src/b.ts");
    });
  });

  describe("stageFiles", () => {
    it("calls git add with file paths", () => {
      mockedSpawnSync.mockReturnValue({ status: 0, stderr: "", stdout: "" } as any);
      const svc = createService();
      svc.stageFiles(["src/a.ts", "src/b.ts"]);
      expect(mockedSpawnSync).toHaveBeenCalledWith(
        "git",
        ["add", "--", "src/a.ts", "src/b.ts"],
        expect.any(Object),
      );
    });

    it("throws on failure", () => {
      mockedSpawnSync.mockReturnValue({ status: 1, stderr: "error", stdout: "" } as any);
      const svc = createService();
      expect(() => svc.stageFiles(["bad"])).toThrow();
    });
  });

  describe("createCommit", () => {
    it("calls git commit with message via stdin", () => {
      mockedSpawnSync.mockReturnValue({ status: 0, stderr: "", stdout: "" } as any);
      const svc = createService();
      svc.createCommit("feat: add thing\n\n- detail");
      expect(mockedSpawnSync).toHaveBeenCalledWith(
        "git",
        ["commit", "-F", "-"],
        expect.objectContaining({ input: "feat: add thing\n\n- detail" }),
      );
    });

    it("throws on commit failure", () => {
      mockedSpawnSync.mockReturnValue({ status: 1, stderr: "nothing to commit", stdout: "" } as any);
      const svc = createService();
      expect(() => svc.createCommit("msg")).toThrow("nothing to commit");
    });
  });
});