import { describe, it, expect } from "vitest";
import { createTestConfig, createMockLLM } from "./helpers.js";
import { CommitGenerator } from "../src/generation/CommitGenerator.js";
import type { CommitContext } from "../src/types/types.js";

function createGenerator(llmOverrides: Parameters<typeof createMockLLM>[0] = {}) {
  const config = createTestConfig();
  const llm = createMockLLM(llmOverrides);
  return new CommitGenerator(llm, config);
}

function makeContext(overrides: Partial<CommitContext> = {}): CommitContext {
  return {
    branch: "feature/42-login",
    issue: "#42",
    stagedStats: "1 file changed, 10 insertions(+)",
    stagedFileSummaries: "M: src/auth.ts",
    recentStyleHints: "Recent commit types: feat, fix",
    recentCommits: "abc123 feat: add login page",
    changedSymbols: "function authenticate",
    fileContext: "=== src/auth.ts (M) [diff] ===\n+new code",
    _diff: "diff --git a/src/auth.ts b/src/auth.ts\n+new code",
    ...overrides,
  };
}

describe("CommitGenerator", () => {

  describe("buildReasoningPrompt", () => {
    it("includes branch and issue in prompt", () => {
      const gen = createGenerator();
      const prompt = gen.buildReasoningPrompt("src/auth.ts", makeContext());
      expect(prompt).toContain("feature/42-login");
      expect(prompt).toContain("#42");
    });

    it("includes staged stats", () => {
      const gen = createGenerator();
      const prompt = gen.buildReasoningPrompt("src/auth.ts", makeContext());
      expect(prompt).toContain("1 file changed");
    });

    it("includes file context when available", () => {
      const gen = createGenerator();
      const prompt = gen.buildReasoningPrompt("src/auth.ts", makeContext());
      expect(prompt).toContain("File context:");
      expect(prompt).toContain("+new code");
    });

    it("falls back to diff sketch when no file context", () => {
      const gen = createGenerator();
      const context = makeContext({ fileContext: "" });
      const prompt = gen.buildReasoningPrompt("src/auth.ts", context);
      expect(prompt).toContain("Diff sketch:");
    });

    it("includes changed symbols when present", () => {
      const gen = createGenerator();
      const prompt = gen.buildReasoningPrompt("src/auth.ts", makeContext());
      expect(prompt).toContain("Changed symbols:");
      expect(prompt).toContain("function authenticate");
    });

    it("omits changed symbols when empty", () => {
      const gen = createGenerator();
      const context = makeContext({ changedSymbols: "" });
      const prompt = gen.buildReasoningPrompt("src/auth.ts", context);
      expect(prompt).not.toContain("Changed symbols:");
    });

    it("includes classification guide for commit types", () => {
      const gen = createGenerator();
      const prompt = gen.buildReasoningPrompt("src/auth.ts", makeContext());
      expect(prompt).toContain("feat:");
      expect(prompt).toContain("fix:");
      expect(prompt).toContain("refactor:");
      expect(prompt).toContain("chore:");
    });

    it("uses staged file summaries when available", () => {
      const gen = createGenerator();
      const prompt = gen.buildReasoningPrompt("src/auth.ts", makeContext());
      expect(prompt).toContain("Staged files:");
      expect(prompt).toContain("M: src/auth.ts");
    });

    it("falls back to raw files when no summaries", () => {
      const gen = createGenerator();
      const context = makeContext({ stagedFileSummaries: "" });
      const prompt = gen.buildReasoningPrompt("src/auth.ts", context);
      expect(prompt).toContain("Staged files:");
      expect(prompt).toContain("src/auth.ts");
    });
  });

  describe("buildMessagePrompt", () => {
    it("includes reasoning text", () => {
      const gen = createGenerator();
      const prompt = gen.buildMessagePrompt("src/auth.ts", makeContext(), "TYPE: feat\nSCOPE: auth");
      expect(prompt).toContain("TYPE: feat");
      expect(prompt).toContain("SCOPE: auth");
    });

    it("shows NONE when reasoning is empty", () => {
      const gen = createGenerator();
      const prompt = gen.buildMessagePrompt("src/auth.ts", makeContext(), "");
      expect(prompt).toMatch(/Analysis:\s*NONE/);
    });

    it("includes summary max length from config", () => {
      const gen = createGenerator();
      const prompt = gen.buildMessagePrompt("src/auth.ts", makeContext(), "reasoning");
      expect(prompt).toContain("72 characters");
    });

    it("includes bullet count guidance", () => {
      const gen = createGenerator();
      const prompt = gen.buildMessagePrompt("src/auth.ts", makeContext(), "reasoning");
      expect(prompt).toContain("2 bullets");
      expect(prompt).toContain("3 are needed");
    });

    it("includes breaking change hint when diff mentions it", () => {
      const gen = createGenerator();
      const context = makeContext({ _diff: "BREAKING CHANGE: removed API endpoint" });
      const prompt = gen.buildMessagePrompt("src/auth.ts", context, "reasoning");
      expect(prompt).toContain("breaking changes");
    });

    it("omits breaking change hint for normal diffs", () => {
      const gen = createGenerator();
      const context = makeContext({ _diff: "normal diff content" });
      const prompt = gen.buildMessagePrompt("src/auth.ts", context, "reasoning");
      // Should not contain the special breaking change hint
      expect(prompt).not.toContain("The diff mentions breaking changes");
    });

    it("includes recent commits", () => {
      const gen = createGenerator();
      const prompt = gen.buildMessagePrompt("src/auth.ts", makeContext(), "reasoning");
      expect(prompt).toContain("Recent commits:");
      expect(prompt).toContain("feat: add login page");
    });

    it("includes extra instruction when set", () => {
      const gen = createGenerator();
      gen.extraInstruction = "Focus on security aspects";
      const prompt = gen.buildMessagePrompt("src/auth.ts", makeContext(), "reasoning");
      expect(prompt).toContain("User instruction: Focus on security aspects");
    });

    it("omits extra instruction when empty", () => {
      const gen = createGenerator();
      gen.extraInstruction = "";
      const prompt = gen.buildMessagePrompt("src/auth.ts", makeContext(), "reasoning");
      expect(prompt).not.toContain("User instruction:");
    });

    it("includes good and bad summary examples", () => {
      const gen = createGenerator();
      const prompt = gen.buildMessagePrompt("src/auth.ts", makeContext(), "reasoning");
      expect(prompt).toContain("Bad summaries:");
      expect(prompt).toContain("Good summaries:");
    });
  });

  describe("sanitizeCommitMessage", () => {
    it("removes code fences", () => {
      const gen = createGenerator();
      const input = "```\nfeat: add auth\n\n- add login\n```";
      expect(gen.sanitizeCommitMessage(input)).toBe("feat: add auth\n\n- add login");
    });

    it("removes markdown code fence with language", () => {
      const gen = createGenerator();
      const input = "```markdown\nfeat: something\n```";
      expect(gen.sanitizeCommitMessage(input)).toBe("feat: something");
    });

    it("removes plaintext prefix", () => {
      const gen = createGenerator();
      const input = "plaintext\nfeat: add feature";
      expect(gen.sanitizeCommitMessage(input)).toBe("feat: add feature");
    });

    it("collapses multiple blank lines", () => {
      const gen = createGenerator();
      const input = "feat: add thing\n\n\n\n\n- detail one\n\n\n\n- detail two";
      const result = gen.sanitizeCommitMessage(input);
      expect(result).not.toContain("\n\n\n");
    });

    it("trims whitespace", () => {
      const gen = createGenerator();
      expect(gen.sanitizeCommitMessage("  feat: add thing  ")).toBe("feat: add thing");
    });

    it("handles empty input", () => {
      const gen = createGenerator();
      expect(gen.sanitizeCommitMessage("")).toBe("");
    });

    it("handles undefined-ish input", () => {
      const gen = createGenerator();
      expect(gen.sanitizeCommitMessage(undefined as any)).toBe("");
    });
  });

  describe("isRateLimitError (via withRetry)", () => {
    it("detects status 429", () => {
      const gen = createGenerator();
      const result = (gen as any).isRateLimitError({ status: 429 });
      expect(result).toBe(true);
    });

    it("detects statusCode 429", () => {
      const gen = createGenerator();
      const result = (gen as any).isRateLimitError({ statusCode: 429 });
      expect(result).toBe(true);
    });

    it("detects code rate_limit_exceeded", () => {
      const gen = createGenerator();
      const result = (gen as any).isRateLimitError({ code: "rate_limit_exceeded" });
      expect(result).toBe(true);
    });

    it("detects rate limit in message", () => {
      const gen = createGenerator();
      const result = (gen as any).isRateLimitError({ message: "Rate limit exceeded" });
      expect(result).toBe(true);
    });

    it("returns false for non-rate-limit errors", () => {
      const gen = createGenerator();
      expect((gen as any).isRateLimitError({ status: 500 })).toBe(false);
      expect((gen as any).isRateLimitError({ message: "server error" })).toBe(false);
    });

    it("returns false for null/undefined", () => {
      const gen = createGenerator();
      expect((gen as any).isRateLimitError(null)).toBe(false);
      expect((gen as any).isRateLimitError(undefined)).toBe(false);
    });

    it("returns false for non-objects", () => {
      const gen = createGenerator();
      expect((gen as any).isRateLimitError("string")).toBe(false);
      expect((gen as any).isRateLimitError(42)).toBe(false);
    });
  });

  describe("withRetry", () => {
    it("returns result on first success", async () => {
      const gen = createGenerator();
      const result = await (gen as any).withRetry(() => Promise.resolve("ok"));
      expect(result).toBe("ok");
    });

    it("retries on rate limit error and succeeds", async () => {
      const gen = createGenerator();
      let attempts = 0;
      const result = await (gen as any).withRetry(
        () => {
          attempts++;
          if (attempts === 1) throw { status: 429 };
          return Promise.resolve("ok after retry");
        },
        { initialDelayMs: 1, maxDelayMs: 5 },
      );
      expect(result).toBe("ok after retry");
      expect(attempts).toBe(2);
    });

    it("throws non-rate-limit errors immediately", async () => {
      const gen = createGenerator();
      let attempts = 0;
      await expect(
        (gen as any).withRetry(
          () => {
            attempts++;
            throw new Error("something went wrong");
          },
          { initialDelayMs: 1 },
        ),
      ).rejects.toThrow("something went wrong");
      expect(attempts).toBe(1);
    });

    it("throws after exhausting retries", async () => {
      const gen = createGenerator();
      let attempts = 0;
      await expect(
        (gen as any).withRetry(
          () => {
            attempts++;
            throw { status: 429, message: "rate limited" };
          },
          { retries: 2, initialDelayMs: 1, maxDelayMs: 2 },
        ),
      ).rejects.toEqual(expect.objectContaining({ status: 429 }));
      expect(attempts).toBe(3); // initial + 2 retries
    });
  });
});