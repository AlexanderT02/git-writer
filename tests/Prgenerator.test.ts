import { describe, it, expect } from "vitest";
import { createTestConfig, createMockLLM } from "./helpers.js";
import { PRGenerator } from "../src/generation/PRGenerator.js";
import type { PRContext } from "../src/types/types.js";

function createGenerator(llmOverrides: Parameters<typeof createMockLLM>[0] = {}) {
  const config = createTestConfig();
  const llm = createMockLLM(llmOverrides);
  return new PRGenerator(llm, config);
}

function makePRContext(overrides: Partial<PRContext> = {}): PRContext {
  return {
    branch: "feature/123-new-login",
    issue: "#123",
    commits: "abc123 feat: add login page\ndef456 fix: handle edge case",
    diff: "diff --git a/src/login.ts\n+new login code",
    fileContexts: "=== src/login.ts (M) [diff] ===\n+new login code",
    ...overrides,
  };
}

describe("PRGenerator", () => {

  describe("buildReasoningPrompt", () => {
    it("includes branch and issue", () => {
      const gen = createGenerator();
      const prompt = gen.buildReasoningPrompt(makePRContext());
      expect(prompt).toContain("feature/123-new-login");
      expect(prompt).toContain("#123");
    });

    it("includes commits", () => {
      const gen = createGenerator();
      const prompt = gen.buildReasoningPrompt(makePRContext());
      expect(prompt).toContain("Commits:");
      expect(prompt).toContain("feat: add login page");
    });

    it("includes diff preview", () => {
      const gen = createGenerator();
      const prompt = gen.buildReasoningPrompt(makePRContext());
      expect(prompt).toContain("Diff preview");
      expect(prompt).toContain("+new login code");
    });

    it("includes file contexts", () => {
      const gen = createGenerator();
      const prompt = gen.buildReasoningPrompt(makePRContext());
      expect(prompt).toContain("File contexts:");
    });

    it("omits empty sections", () => {
      const gen = createGenerator();
      const prompt = gen.buildReasoningPrompt(makePRContext({
        commits: "",
        diff: "",
        fileContexts: "",
      }));
      expect(prompt).not.toContain("Commits:");
      expect(prompt).not.toContain("Diff preview");
      expect(prompt).not.toContain("File contexts:");
    });

    it("includes extra instruction when set", () => {
      const gen = createGenerator();
      gen.extraInstruction = "Emphasize security changes";
      const prompt = gen.buildReasoningPrompt(makePRContext());
      expect(prompt).toContain("User instruction: Emphasize security changes");
    });

    it("omits branch issue when null", () => {
      const gen = createGenerator();
      const prompt = gen.buildReasoningPrompt(makePRContext({ issue: null }));
      expect(prompt).toContain("Branch: feature/123-new-login");
      expect(prompt).not.toContain("(#");
    });
  });

  describe("buildMessagePrompt", () => {
    it("includes the reasoning text", () => {
      const gen = createGenerator();
      const prompt = gen.buildMessagePrompt("Main purpose: add login flow");
      expect(prompt).toContain("Main purpose: add login flow");
    });

    it("specifies TITLE/BODY format", () => {
      const gen = createGenerator();
      const prompt = gen.buildMessagePrompt("reasoning");
      expect(prompt).toContain("TITLE:");
      expect(prompt).toContain("BODY:");
    });

    it("includes formatting rules", () => {
      const gen = createGenerator();
      const prompt = gen.buildMessagePrompt("reasoning");
      expect(prompt).toContain("Do not wrap the output in code fences");
      expect(prompt).toContain("Do not use \"# PR Title\"");
    });
  });

  describe("parsePROutput", () => {
    it("parses standard TITLE/BODY format", () => {
      const gen = createGenerator();
      const output = `TITLE:
Add user authentication flow

BODY:
## Summary
This PR adds the login feature.

## Changes
- Add login page component
- Wire up auth API

## Risks
- No major risks identified`;

      const result = gen.parsePROutput(output);
      expect(result.title).toBe("Add user authentication flow");
      expect(result.description).toContain("## Summary");
      expect(result.description).toContain("login feature");
      expect(result.description).toContain("## Risks");
    });

    it("strips code fences from output", () => {
      const gen = createGenerator();
      const output = "```markdown\nTITLE:\nSome title\n\nBODY:\nSome body\n```";
      const result = gen.parsePROutput(output);
      expect(result.title).toBe("Some title");
      expect(result.description).toBe("Some body");
    });

    it("parses heading-style format (# PR Title / # PR Description)", () => {
      const gen = createGenerator();
      const output = `# PR Title
Add feature X

# PR Description
## Summary
Does something cool.`;

      const result = gen.parsePROutput(output);
      expect(result.title).toBe("Add feature X");
      expect(result.description).toContain("Summary");
    });

    it("handles missing TITLE/BODY markers gracefully", () => {
      const gen = createGenerator();
      const output = "First line as title\nSecond line as body\nThird line";
      const result = gen.parsePROutput(output);
      expect(result.title).toBe("First line as title");
      expect(result.description).toContain("Second line as body");
    });

    it("defaults to 'PR Update' when title is empty", () => {
      const gen = createGenerator();
      const output = "";
      const result = gen.parsePROutput(output);
      expect(result.title).toBe("PR Update");
    });

    it("cleans TITLE: prefix from title", () => {
      const gen = createGenerator();
      const output = "TITLE: My Feature\n\nBODY:\nDescription here";
      const result = gen.parsePROutput(output);
      expect(result.title).toBe("My Feature");
    });

    it("cleans leading bullets from title", () => {
      const gen = createGenerator();
      const output = "TITLE:\n- My Feature\n\nBODY:\nDescription";
      const result = gen.parsePROutput(output);
      expect(result.title).toBe("My Feature");
    });

    it("cleans heading markers from title", () => {
      const gen = createGenerator();
      const output = "TITLE:\n## My Feature\n\nBODY:\nDescription";
      const result = gen.parsePROutput(output);
      expect(result.title).toBe("My Feature");
    });

    it("handles multiline title by joining", () => {
      const gen = createGenerator();
      const output = "TITLE:\nLine one\nLine two\n\nBODY:\nBody content";
      const result = gen.parsePROutput(output);
      expect(result.title).toBe("Line one Line two");
    });

    it("strips BODY: prefix from description", () => {
      const gen = createGenerator();
      const output = "TITLE:\nTitle\n\nBODY:\n## Summary\nGood stuff";
      const result = gen.parsePROutput(output);
      expect(result.description).not.toMatch(/^BODY:/);
      expect(result.description).toContain("## Summary");
    });
  });

  describe("isRateLimitError", () => {
    it("detects 429 status", () => {
      const gen = createGenerator();
      expect((gen as any).isRateLimitError({ status: 429 })).toBe(true);
    });

    it("detects rate_limit_exceeded code", () => {
      const gen = createGenerator();
      expect((gen as any).isRateLimitError({ code: "rate_limit_exceeded" })).toBe(true);
    });

    it("returns false for normal errors", () => {
      const gen = createGenerator();
      expect((gen as any).isRateLimitError({ status: 500 })).toBe(false);
    });
  });
});