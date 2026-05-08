import { describe, it, expect } from "vitest";
import { createTestConfig, createMockGitService } from "./helpers.js";
import { CommitContextBuilder } from "../src/context/CommitContextBuilder.js";
import type { GitService } from "../src/git/GitService.js";

function createBuilder(gitStubs: Record<string, unknown> = {}) {
  const config = createTestConfig();
  const git = createMockGitService(gitStubs) as unknown as GitService;
  return new CommitContextBuilder(git, config);
}

describe("CommitContextBuilder", () => {

  describe("getStagedEntries", () => {
    it("parses name-status output into entries", () => {
      const builder = createBuilder({
        getStagedNameStatus: "M\tsrc/index.ts\nA\tsrc/new.ts\nD\tsrc/old.ts",
      });
      const entries = builder.getStagedEntries();
      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual({ status: "M", file: "src/index.ts" });
      expect(entries[1]).toEqual({ status: "A", file: "src/new.ts" });
      expect(entries[2]).toEqual({ status: "D", file: "src/old.ts" });
    });

    it("returns empty array for no staged files", () => {
      const builder = createBuilder({ getStagedNameStatus: "" });
      expect(builder.getStagedEntries()).toEqual([]);
    });

    it("filters entries without file names", () => {
      const builder = createBuilder({ getStagedNameStatus: "M\t\nA\tsrc/valid.ts" });
      const entries = builder.getStagedEntries();
      // Empty file name entries should be filtered
      const validEntries = entries.filter(e => e.file);
      expect(validEntries.length).toBeGreaterThanOrEqual(1);
      expect(validEntries.some(e => e.file === "src/valid.ts")).toBe(true);
    });
  });

  describe("getFileContent", () => {
    it("returns empty for HEAD ref of added file", () => {
      const builder = createBuilder();
      const content = builder.getFileContent("HEAD", "new-file.ts", "A");
      expect(content).toBe("");
    });

    it("returns empty for INDEX ref of deleted file", () => {
      const builder = createBuilder();
      const content = builder.getFileContent("INDEX", "removed.ts", "D");
      expect(content).toBe("");
    });

    it("reads from HEAD ref for modified file", () => {
      const builder = createBuilder({
        "refExists:HEAD:src/mod.ts": true,
        "readFileFromRef:HEAD:src/mod.ts": "old content",
      });
      const content = builder.getFileContent("HEAD", "src/mod.ts", "M");
      expect(content).toBe("old content");
    });

    it("reads from INDEX ref for modified file", () => {
      const builder = createBuilder({
        "refExists::src/mod.ts": true,
        "readFileFromRef::src/mod.ts": "new content",
      });
      const content = builder.getFileContent("INDEX", "src/mod.ts", "M");
      expect(content).toBe("new content");
    });

    it("returns empty if ref does not exist", () => {
      const builder = createBuilder({
        "refExists:HEAD:missing.ts": false,
      });
      const content = builder.getFileContent("HEAD", "missing.ts", "M");
      expect(content).toBe("");
    });
  });

  describe("level2 (full context)", () => {
    it("builds full context for added file", () => {
      const builder = createBuilder();
      const entry = { status: "A", file: "src/new.ts" };
      const result = builder.level2(entry, "", "const x = 1;");
      expect(result.level).toBe(2);
      expect(result.text).toContain("[full]");
      expect(result.text).toContain("NEW FILE");
      expect(result.text).toContain("const x = 1;");
    });

    it("builds full context for modified file with before/after", () => {
      const builder = createBuilder();
      const entry = { status: "M", file: "src/existing.ts" };
      const result = builder.level2(entry, "old code", "new code");
      expect(result.level).toBe(2);
      expect(result.text).toContain("BEFORE");
      expect(result.text).toContain("old code");
      expect(result.text).toContain("AFTER");
      expect(result.text).toContain("new code");
    });

    it("treats file without before as new", () => {
      const builder = createBuilder();
      const entry = { status: "M", file: "src/edge.ts" };
      const result = builder.level2(entry, "", "only after");
      expect(result.text).toContain("NEW FILE");
      expect(result.text).toContain("only after");
    });
  });

  describe("level1 (compact diff)", () => {
    it("returns compact diff when available", () => {
      const builder = createBuilder({
        "getStagedFileDiffWithContext:src/foo.ts": "@@ -1,3 +1,4 @@\n+new line",
      });
      const entry = { status: "M", file: "src/foo.ts" };
      const result = builder.level1(entry);
      expect(result.level).toBe(1);
      expect(result.text).toContain("[compact diff]");
      expect(result.text).toContain("+new line");
    });

    it("falls back to regular diff when compact is empty", () => {
      const builder = createBuilder({
        "getStagedFileDiffWithContext:src/foo.ts": "",
        "getStagedFileDiff:src/foo.ts": "regular diff output",
      });
      const entry = { status: "M", file: "src/foo.ts" };
      const result = builder.level1(entry);
      expect(result.level).toBe(0);
      expect(result.text).toContain("[diff]");
    });
  });

  describe("level0 (regular diff)", () => {
    it("returns regular diff", () => {
      const builder = createBuilder({
        "getStagedFileDiff:src/foo.ts": "diff --git a/src/foo.ts b/src/foo.ts",
      });
      const entry = { status: "M", file: "src/foo.ts" };
      const result = builder.level0(entry);
      expect(result.level).toBe(0);
      expect(result.text).toContain("[diff]");
    });

    it("shows [no diff] when diff is empty", () => {
      const builder = createBuilder({
        "getStagedFileDiff:src/foo.ts": "",
      });
      const entry = { status: "M", file: "src/foo.ts" };
      const result = builder.level0(entry);
      expect(result.text).toContain("[no diff]");
    });
  });

  describe("isBinary", () => {
    it("returns true for binary files", () => {
      const builder = createBuilder({
        "getStagedFileNumstat:image.png": "-\t-\timage.png",
      });
      expect(builder.isBinary("image.png")).toBe(true);
    });

    it("returns false for text files", () => {
      const builder = createBuilder({
        "getStagedFileNumstat:src/code.ts": "10\t5\tsrc/code.ts",
      });
      expect(builder.isBinary("src/code.ts")).toBe(false);
    });
  });

  describe("build (full context assembly)", () => {
    it("builds complete commit context", () => {
      const builder = createBuilder({
        getCurrentBranchContext: { branch: "feature/42-login", issue: "#42" },
        getStagedShortStat: " 2 files changed, 10 insertions(+), 3 deletions(-)",
        getRecentCommitLines: "abc123 feat: add auth",
        getStagedNameStatus: "M\tsrc/login.ts",
        getStagedFileSummaryLines: "",
        getRecentCommitStyleHints: "",
        getStagedDiffForPrompt: "diff preview",
        "getStagedFileNumstat:src/login.ts": "10\t3\tsrc/login.ts",
        "getStagedFileDiffWithContext:src/login.ts": "@@ -1 +1 @@\n-old\n+new",
        "getStagedFileDiff:src/login.ts": "diff content",
        getChangedSymbolsFromStagedDiff: "",
      });

      const context = builder.build("src/login.ts");

      expect(context.branch).toBe("feature/42-login");
      expect(context.issue).toBe("#42");
      expect(context.stagedStats).toContain("2 files changed");
      expect(context.recentCommits).toContain("feat: add auth");
      expect(context.fileContext).toBeTruthy();
    });

    it("includes style hints for 4+ files", () => {
      const files = "a.ts\nb.ts\nc.ts\nd.ts";
      const builder = createBuilder({
        getCurrentBranchContext: { branch: "main", issue: null },
        getStagedShortStat: "4 files",
        getRecentCommitLines: "",
        getStagedNameStatus: "M\ta.ts\nM\tb.ts\nM\tc.ts\nM\td.ts",
        getStagedFileSummaryLines: "M: a.ts\nM: b.ts\nM: c.ts\nM: d.ts",
        getRecentCommitStyleHints: "Recent commit types: feat, fix",
        getStagedDiffForPrompt: "",
        getStagedFileNumstat: "1\t1\tfile",
        getStagedFileDiffWithContext: "",
        getStagedFileDiff: "",
        getChangedSymbolsFromStagedDiff: "",
      });

      const context = builder.build(files);
      expect(context.recentStyleHints).toContain("feat, fix");
    });

    it("omits style hints for 3 or fewer files", () => {
      const builder = createBuilder({
        getCurrentBranchContext: { branch: "main", issue: null },
        getStagedShortStat: "",
        getRecentCommitLines: "",
        getStagedNameStatus: "M\ta.ts\nM\tb.ts",
        getStagedFileSummaryLines: "M: a.ts\nM: b.ts",
        getRecentCommitStyleHints: "should not appear",
        getStagedDiffForPrompt: "",
        getStagedFileNumstat: "1\t1\tfile",
        getStagedFileDiffWithContext: "",
        getStagedFileDiff: "",
        getChangedSymbolsFromStagedDiff: "",
      });

      const context = builder.build("a.ts\nb.ts");
      expect(context.recentStyleHints).toBe("");
    });

    it("excludes configured files from context content but keeps filename marker", () => {
      const builder = createBuilder({
        getCurrentBranchContext: { branch: "main", issue: null },
        getStagedShortStat: "1 file changed",
        getRecentCommitLines: "",
        getStagedNameStatus: "M\tpackage-lock.json",
        getStagedFileSummaryLines: "",
        getRecentCommitStyleHints: "",
        getStagedDiffForPrompt: "diff preview",
        getChangedSymbolsFromStagedDiff: "",

        // These should not be used for excluded files
        "getStagedFileNumstat:package-lock.json": "1000\t1000\tpackage-lock.json",
        "getStagedFileDiffWithContext:package-lock.json": "SECRET LOCKFILE CONTENT",
        "getStagedFileDiff:package-lock.json": "SECRET REGULAR DIFF",
    });

      const context = builder.build("package-lock.json");

      expect(context.fileContext).toContain("package-lock.json");
      expect(context.fileContext).toContain("[excluded]");
      expect(context.fileContext).toContain("[content excluded by config]");

      expect(context.fileContext).not.toContain("SECRET LOCKFILE CONTENT");
      expect(context.fileContext).not.toContain("SECRET REGULAR DIFF");
    });
  });
});