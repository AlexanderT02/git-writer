/**
 * unit test: Commit Pipeline
 *
 * Wires the real CommitContextBuilder → CommitGenerator chain together
 * using a mock GitService and mock LLM.  Verifies that the full flow —
 * context assembly, prompt building, LLM call, output sanitization —
 * produces a usable commit message.
 */
import { describe, it, expect, vi } from "vitest";
import { CommitContextBuilder } from "../src/context/CommitContextBuilder.js";
import { CommitGenerator } from "../src/generation/CommitGenerator.js";
import { createTestConfig, createMockGitService, createMockLLM } from "./helpers.js";

function setupPipeline(opts: {
  stagedFiles?: string;
  stagedDiff?: string;
  numstat?: string;
  branch?: string;
  recentCommits?: string;
  reasoningResponse?: string;
  generationResponse?: string;
}) {
  const config = createTestConfig();
  const git = createMockGitService();

  const files = opts.stagedFiles ?? "src/auth.ts";
  const diff = opts.stagedDiff ?? "diff --git a/src/auth.ts b/src/auth.ts\n+export function login() {}";

  // Wire up git mock returns
  git.getStagedFileNames = vi.fn().mockReturnValue(files);
  git.getStagedDiffForPrompt = vi.fn().mockReturnValue(diff);
  git.getCurrentBranch = vi.fn().mockReturnValue(opts.branch ?? "feature/42-auth");
  git.getCurrentBranchContext = vi.fn().mockReturnValue({
    branch: opts.branch ?? "feature/42-auth",
    issue: "#42",
  });
  git.getRecentCommitStyleHints = vi.fn().mockReturnValue(
    opts.recentCommits ?? "Recent commit types: feat, fix",
  );
  git.runGitOrEmpty = vi.fn().mockImplementation((args: string[]) => {
    if (args.includes("--numstat")) return opts.numstat ?? "10\t2\tsrc/auth.ts";
    if (args.includes("--name-status")) return "M\tsrc/auth.ts";
    if (args.includes("diff")) return diff;
    if (args.includes("log")) return "abc1234 feat: add login";
    if (args.includes("show")) return "+export function login() {}";
    return "";
  });
  git.runGit = vi.fn().mockImplementation((args: string[]) => {
    return git.runGitOrEmpty(args);
  });
  git.refExists = vi.fn().mockReturnValue(true);
  git.getStagedNumstat = vi.fn().mockReturnValue(opts.numstat ?? "10\t2\tsrc/auth.ts");
  git.getChangedSymbolsFromStagedDiff = vi.fn().mockReturnValue("function login");
  git.getStagedFileSummaryLines = vi.fn().mockReturnValue("M: src/auth.ts");
  git.getLastCommitStats = vi.fn().mockReturnValue("1 file changed, 10 insertions(+), 2 deletions(-)");

  const llm = createMockLLM({
    complete: opts.reasoningResponse ?? "This adds authentication. Type: feat. Scope: auth.",
    stream: opts.generationResponse ?? "feat(auth): add login function\n\n- Implement basic login endpoint",
  });

  const contextBuilder = new CommitContextBuilder(git as any, config);
  const generator = new CommitGenerator(llm, config);

  return { git, llm, contextBuilder, generator, config, files };
}

describe("Commit Pipeline Unit", () => {
  it("produces a valid commit message from staged changes", async () => {
    const { contextBuilder, generator, files } = setupPipeline({});

    const context = contextBuilder.build(files);
    const result = await generator.generate(files, context);

    expect(result.message).toBeTruthy();
    expect(result.message).toContain("feat");
    expect(result.usage).toBeDefined();
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it("passes branch context through to the reasoning prompt", async () => {
    const { contextBuilder, generator, llm, files } = setupPipeline({
      branch: "bugfix/99-crash-on-submit",
    });

    const context = contextBuilder.build(files);
    await generator.generate(files, context);

    // The reasoning prompt (first LLM call) should mention the branch
    const reasoningCall = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(reasoningCall).toContain("bugfix/99-crash-on-submit");
  });

  it("injects reasoning into the message prompt", async () => {
    const reasoning = "Analysis: this refactors the payment module for clarity.";
    const { contextBuilder, generator, llm, files } = setupPipeline({
      reasoningResponse: reasoning,
    });

    const context = contextBuilder.build(files);
    await generator.generate(files, context);

    // The generation call (stream) should contain the reasoning output
    const streamCall = (llm.stream as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(streamCall).toContain(reasoning);
  });

  it("sanitizes code fences from LLM output", async () => {
    const { contextBuilder, generator, files } = setupPipeline({
      generationResponse: "```\nfeat(auth): add login\n\n- add endpoint\n```",
    });

    const context = contextBuilder.build(files);
    const result = await generator.generate(files, context);

    expect(result.message).not.toContain("```");
    expect(result.message).toContain("feat(auth): add login");
  });

  it("handles multi-file staged changes", async () => {
    const { contextBuilder, generator, files } = setupPipeline({
      stagedFiles: "src/auth.ts\nsrc/middleware.ts\nsrc/routes.ts\npackage.json",
      numstat: "10\t2\tsrc/auth.ts\n5\t0\tsrc/middleware.ts\n8\t3\tsrc/routes.ts\n1\t1\tpackage.json",
    });

    const context = contextBuilder.build(files);
    const result = await generator.generate(files, context);

    expect(result.message).toBeTruthy();
  });

  it("context builder respects token budget with many files", () => {
    const manyFiles = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`).join("\n");
    const numstat = Array.from({ length: 50 }, (_, i) => `100\t50\tsrc/file${i}.ts`).join("\n");

    const { contextBuilder } = setupPipeline({
      stagedFiles: manyFiles,
      numstat,
    });

    const context = contextBuilder.build(manyFiles);

    // fileContext should exist but be bounded — not contain full content for all 50 files
    const contextLength = (context.fileContext ?? "").length;
    // With a 50k token budget (~200k chars), the context shouldn't explode
    expect(contextLength).toBeLessThan(300_000);
  });

  it("handles empty diff gracefully", async () => {
    const { contextBuilder, generator, files } = setupPipeline({
      stagedDiff: "",
      generationResponse: "chore: empty commit",
    });

    const context = contextBuilder.build(files);
    const result = await generator.generate(files, context);

    expect(result.message).toBeTruthy();
  });
});