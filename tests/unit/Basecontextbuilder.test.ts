import { describe, it, expect } from "vitest";
import { createTestConfig, createMockGitService } from "./helpers.js";
import { CommitContextBuilder } from "../../src/context/CommitContextBuilder.js";
import type { GitService } from "../../src/git/GitService.js";

/**
 * We test BaseContextBuilder behavior through CommitContextBuilder since
 * BaseContextBuilder is abstract. The protected methods we test here
 * (filePenalty, parseNumstat, prioritizeEntries, etc.) are inherited.
 */
function createBuilder(gitStubs: Record<string, unknown> = {}) {
  const config = createTestConfig();
  const git = createMockGitService(gitStubs) as unknown as GitService;
  return new CommitContextBuilder(git, config);
}

describe("BaseContextBuilder", () => {

  describe("parseNumstat", () => {
    it("parses normal numstat output", () => {
      const builder = createBuilder();
      // parseNumstat is protected, so we call it via a known public path
      // We'll test it indirectly through parseNumstat access
      const result = (builder as any).parseNumstat("10\t5\tsrc/foo.ts");
      expect(result).toEqual({
        additions: 10,
        deletions: 5,
        total: 15,
        binary: false,
      });
    });

    it("detects binary files (dash-dash numstat)", () => {
      const builder = createBuilder();
      const result = (builder as any).parseNumstat("-\t-\timage.png");
      expect(result).toEqual({
        additions: 0,
        deletions: 0,
        total: 0,
        binary: true,
      });
    });

    it("handles empty numstat output", () => {
      const builder = createBuilder();
      const result = (builder as any).parseNumstat("");
      expect(result).toEqual({
        additions: 0,
        deletions: 0,
        total: 0,
        binary: false,
      });
    });

    it("handles whitespace-only numstat output", () => {
      const builder = createBuilder();
      const result = (builder as any).parseNumstat("   \n  ");
      expect(result).toEqual({
        additions: 0,
        deletions: 0,
        total: 0,
        binary: false,
      });
    });

    it("handles additions-only numstat", () => {
      const builder = createBuilder();
      const result = (builder as any).parseNumstat("42\t0\tnew-file.ts");
      expect(result).toEqual({
        additions: 42,
        deletions: 0,
        total: 42,
        binary: false,
      });
    });
  });

  describe("filePenalty", () => {
    it("returns 0 for regular source files", () => {
      const builder = createBuilder();
      expect((builder as any).filePenalty("src/index.ts")).toBe(0);
      expect((builder as any).filePenalty("lib/utils.js")).toBe(0);
      expect((builder as any).filePenalty("README.md")).toBe(0);
    });

    it("penalizes lock files heavily", () => {
      const builder = createBuilder();
      expect((builder as any).filePenalty("package-lock.json")).toBe(50);
      expect((builder as any).filePenalty("pnpm-lock.yaml")).toBe(50);
      expect((builder as any).filePenalty("yarn.lock")).toBe(50);
      expect((builder as any).filePenalty("bun.lockb")).toBe(50);
    });

    it("penalizes lock files in subdirectories", () => {
      const builder = createBuilder();
      expect((builder as any).filePenalty("packages/web/package-lock.json")).toBe(50);
    });

    it("penalizes minified files", () => {
      const builder = createBuilder();
      expect((builder as any).filePenalty("dist/bundle.min.js")).toBe(40);
      expect((builder as any).filePenalty("styles.min.css")).toBe(40);
    });

    it("penalizes build/dist output directories", () => {
      const builder = createBuilder();
      expect((builder as any).filePenalty("dist/index.js")).toBe(35);
      expect((builder as any).filePenalty("build/output.js")).toBe(35);
      expect((builder as any).filePenalty("coverage/lcov.info")).toBe(35);
      expect((builder as any).filePenalty("vendor/lib.js")).toBe(35);
    });

    it("penalizes binary/media files", () => {
      const builder = createBuilder();
      expect((builder as any).filePenalty("logo.png")).toBe(30);
      expect((builder as any).filePenalty("photo.jpg")).toBe(30);
      expect((builder as any).filePenalty("icon.ico")).toBe(30);
      expect((builder as any).filePenalty("archive.zip")).toBe(30);
      expect((builder as any).filePenalty("video.mp4")).toBe(30);
    });

    it("returns high penalty for empty file name", () => {
      const builder = createBuilder();
      expect((builder as any).filePenalty("")).toBe(100);
    });
  });

  describe("cost estimation", () => {
    it("estimates token cost as chars / 4 rounded up", () => {
      const builder = createBuilder();
      expect((builder as any).cost("")).toBe(0);
      expect((builder as any).cost("abcd")).toBe(1);
      expect((builder as any).cost("abcde")).toBe(2);
      expect((builder as any).cost("a".repeat(100))).toBe(25);
    });
  });

  describe("getPerFileBudget", () => {
    it("gives full budget for single file", () => {
      const builder = createBuilder();
      expect((builder as any).getPerFileBudget(1, 10000)).toBe(10000);
    });

    it("caps per-file budget for multiple files", () => {
      const builder = createBuilder();
      const budget = (builder as any).getPerFileBudget(10, 10000);
      // fairShare = 1000, softCap = max(2000, 2500) = 2500
      expect(budget).toBe(2500);
    });

    it("enforces minimum budget of 1000", () => {
      const builder = createBuilder();
      const budget = (builder as any).getPerFileBudget(100, 100);
      expect(budget).toBe(1000);
    });
  });

  describe("getContextLines", () => {
    it("clamps context lines to max 2", () => {
      const builder = createBuilder();
      // config.context.contextLines is 30, but getContextLines clamps to max 2
      expect((builder as any).getContextLines()).toBe(2);
    });

    it("respects small values", () => {
      const config = createTestConfig();
      config.context.contextLines = 1;
      const git = createMockGitService() as unknown as GitService;
      const builder = new CommitContextBuilder(git, config);
      expect((builder as any).getContextLines()).toBe(1);
    });
  });

  describe("parseNameStatusLine", () => {
    it("parses added file", () => {
      const builder = createBuilder();
      const result = (builder as any).parseNameStatusLine("A\tsrc/new.ts");
      expect(result).toEqual({ status: "A", file: "src/new.ts" });
    });

    it("parses modified file", () => {
      const builder = createBuilder();
      const result = (builder as any).parseNameStatusLine("M\tsrc/existing.ts");
      expect(result).toEqual({ status: "M", file: "src/existing.ts" });
    });

    it("parses deleted file", () => {
      const builder = createBuilder();
      const result = (builder as any).parseNameStatusLine("D\told-file.ts");
      expect(result).toEqual({ status: "D", file: "old-file.ts" });
    });

    it("parses renamed file (takes last part as file)", () => {
      const builder = createBuilder();
      const result = (builder as any).parseNameStatusLine("R100\told.ts\tnew.ts");
      expect(result.status).toBe("R");
      expect(result.file).toBe("new.ts");
    });
  });

  describe("skipped / unknownFile / binary / deleted / noDiff helpers", () => {
    it("returns skipped result with level -1", () => {
      const builder = createBuilder();
      const entry = { status: "M", file: "src/big.ts" };
      const result = (builder as any).skipped(entry);
      expect(result.level).toBe(-1);
      expect(result.text).toContain("src/big.ts");
      expect(result.text).toContain("budget exhausted");
    });

    it("returns unknownFile result with level -1", () => {
      const builder = createBuilder();
      const result = (builder as any).unknownFile();
      expect(result.level).toBe(-1);
      expect(result.text).toContain("unknown file");
    });

    it("returns binary result with level -1", () => {
      const builder = createBuilder();
      const entry = { status: "A", file: "image.png" };
      const result = (builder as any).binary(entry);
      expect(result.level).toBe(-1);
      expect(result.text).toContain("binary");
      expect(result.text).toContain("image.png");
    });

    it("returns deleted result with level 1", () => {
      const builder = createBuilder();
      const entry = { status: "D", file: "removed.ts" };
      const result = (builder as any).deleted(entry, { deletions: 42 });
      expect(result.level).toBe(1);
      expect(result.text).toContain("DELETED FILE");
      expect(result.text).toContain("42");
    });

    it("returns noDiff result with level 0", () => {
      const builder = createBuilder();
      const entry = { status: "M", file: "empty-change.ts" };
      const result = (builder as any).noDiff(entry);
      expect(result.level).toBe(0);
      expect(result.text).toContain("[no diff]");
    });
  });

  describe("truncatedDiff", () => {
    it("truncates large diffs within budget", () => {
      const builder = createBuilder();
      const entry = { status: "M", file: "big.ts" };
      const longDiff = "x".repeat(10000);
      const result = (builder as any).truncatedDiff(entry, longDiff, 100);
      expect(result.level).toBe(0);
      expect(result.text).toContain("[truncated");
      expect(result.text.length).toBeLessThan(longDiff.length);
    });

    it("returns skipped if budget is zero", () => {
      const builder = createBuilder();
      const entry = { status: "M", file: "big.ts" };
      const result = (builder as any).truncatedDiff(entry, "some diff", 0);
      expect(result.level).toBe(-1);
      expect(result.text).toContain("budget exhausted");
    });
  });

  describe("shouldTryFullContext", () => {
    it("returns false when budget is 0", () => {
      const builder = createBuilder();
      const entry = { status: "A", file: "small.ts" };
      const size = { additions: 5, deletions: 0, total: 5, binary: false };
      expect((builder as any).shouldTryFullContext(entry, size, 0)).toBe(false);
    });

    it("returns true for small added files", () => {
      const builder = createBuilder();
      const entry = { status: "A", file: "small.ts" };
      const size = { additions: 10, deletions: 0, total: 10, binary: false };
      expect((builder as any).shouldTryFullContext(entry, size, 5000)).toBe(true);
    });

    it("returns false for very large added files", () => {
      const builder = createBuilder();
      const entry = { status: "A", file: "huge.ts" };
      const size = { additions: 9999, deletions: 0, total: 9999, binary: false };
      expect((builder as any).shouldTryFullContext(entry, size, 5000)).toBe(false);
    });

    it("returns true for small modifications", () => {
      const builder = createBuilder();
      const entry = { status: "M", file: "tiny.ts" };
      const size = { additions: 3, deletions: 2, total: 5, binary: false };
      expect((builder as any).shouldTryFullContext(entry, size, 5000)).toBe(true);
    });
  });

  describe("prioritizeEntries", () => {
    it("sorts lock files after source files", () => {
      const builder = createBuilder();
      const entries = [
        { status: "M", file: "package-lock.json" },
        { status: "M", file: "src/index.ts" },
      ];

      // Need to stub getChangeSize for prioritization
      (builder as any).getChangeSize = () => ({
        additions: 5, deletions: 5, total: 10, binary: false,
      });

      const sorted = (builder as any).prioritizeEntries(entries);
      expect(sorted[0].file).toBe("src/index.ts");
      expect(sorted[1].file).toBe("package-lock.json");
    });

    it("sorts smaller changes before larger ones (same penalty)", () => {
      const builder = createBuilder();
      const entries = [
        { status: "M", file: "src/big.ts" },
        { status: "M", file: "src/small.ts" },
      ];

      const sizes: Record<string, number> = {
        "src/big.ts": 500,
        "src/small.ts": 10,
      };

      (builder as any).getChangeSize = (file: string) => ({
        additions: sizes[file] ?? 0,
        deletions: 0,
        total: sizes[file] ?? 0,
        binary: false,
      });

      const sorted = (builder as any).prioritizeEntries(entries);
      expect(sorted[0].file).toBe("src/small.ts");
      expect(sorted[1].file).toBe("src/big.ts");
    });
  });
});