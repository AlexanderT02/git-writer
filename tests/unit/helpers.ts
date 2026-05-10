import { vi } from "vitest";
import type { AppConfig } from "../../src/config/config.js";
import type { LLM } from "../../src/llm/LLM.js";
import type { LLMResult } from "../../src/types/types.js";

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    app: { name: "git-writer", command: "gw" },
    llm: {
    defaultProvider: "openai",
    providers: {
        openai: {
        reasoningModel: "gpt-4o-mini",
        generationModel: "gpt-5.4-mini",
        },
        ollama: {
        reasoningModel: "llama3.1",
        generationModel: "llama3.1",
        },
        gemini: {
        reasoningModel: "gemini-2.5-flash",
        generationModel: "gemini-2.5-flash-lite",
        },
    },
    },
    git: {
      recentCommitCount: 8,
      recentStyleCommitCount: 12,
      largeDiffLineLimit: 800,
      largeDiffHeaderLimit: 150,
      maxRecentScopes: 10,
      maxChangedSymbols: 30,
      maxChangedSymbolLength: 120,
      maxBufferBytes: 10 * 1024 * 1024,
    },
    context: {
      tokenBudget: 50_000,
      smallFileThreshold: 3_000,
      contextLines: 30,
      maxFileBufferBytes: 10 * 1024 * 1024,
      excludedContentPatterns: [
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lockb",
        "dist/**",
        "build/**",
        "coverage/**",
        "vendor/**",
        "**/*.min.js",
        "**/*.min.css",
      ],
    },
    staging: {
      pageSize: 25,
      loop: false,
      message: "Select files to stage",
      help: "↑/↓ move · Space select · Enter confirm",
    },
    commit: {
      summaryMaxLength: 72,
      reasoningDiffPreviewLines: 80,
      preferredBulletCount: 2,
      maxBulletCount: 3,
    },
    
    ui: {
      clearScreen: true,
      borderWidth: 60,
      generatedCommitTitle: "Generated Commit",
      generatingPlaceholder: "...generating",
      actionMenuMessage: "What do you want to do?",
      refineMessage: "Refinement instruction",
      editMessage: "Edit commit message",
      emptyInputMessage: "Enter something",
      actions: {
        commit: " Commit",
        edit: " Edit message manually",
        regenerate: " Regenerate",
        refine: " Refine with instruction",
        copy: " Copy to clipboard",
        cancel: "✖ Cancel",
      },
    },
    ...overrides,
  };
}

export function createMockLLM(responses: {
  complete?: string | (() => string);
  stream?: string | (() => string);
} = {}): LLM {
  return {
    complete: vi.fn(async (prompt: string): Promise<LLMResult> => {
      const text = typeof responses.complete === "function"
        ? responses.complete()
        : responses.complete ?? "mock response";

      return {
        text,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      };
    }),

    stream: vi.fn(async (
      prompt: string,
      onText?: (text: string) => void,
    ): Promise<LLMResult> => {
      const text = typeof responses.stream === "function"
        ? responses.stream()
        : responses.stream ?? "mock streamed response";

      onText?.(text);

      return {
        text,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      };
    }),
  } as unknown as LLM;
}

export type MockGitServiceCalls = Record<string, Array<{ args: unknown[] }>>;

export function createMockGitService(
  stubs: Record<string, unknown> = {},
) {
  const calls: MockGitServiceCalls = {};

  const track = (method: string, ...args: unknown[]) => {
    if (!calls[method]) calls[method] = [];
    calls[method].push({ args });
  };

  const service = {
    runGit(args: string[]) {
      track("runGit", args);
      return stubs["runGit"] ?? "";
    },
    runGitOrEmpty(args: string[]) {
      track("runGitOrEmpty", args);
      const key = `runGitOrEmpty:${args.join(" ")}`;
      if (key in stubs) return stubs[key];
      return stubs["runGitOrEmpty"] ?? "";
    },
    getCurrentBranch() {
      track("getCurrentBranch");
      return stubs["getCurrentBranch"] ?? "main";
    },
    getCurrentBranchContext() {
      track("getCurrentBranchContext");
      return stubs["getCurrentBranchContext"] ?? { branch: "main", issue: null };
    },
    getWorkingTreeStatus() {
      track("getWorkingTreeStatus");
      return stubs["getWorkingTreeStatus"] ?? "";
    },
    getStagedFileNames() {
      track("getStagedFileNames");
      return stubs["getStagedFileNames"] ?? "";
    },
    getStagedShortStat() {
      track("getStagedShortStat");
      return stubs["getStagedShortStat"] ?? "";
    },
    getStagedNameStatus() {
      track("getStagedNameStatus");
      return stubs["getStagedNameStatus"] ?? "";
    },
    getStagedNumstat() {
      track("getStagedNumstat");
      return stubs["getStagedNumstat"] ?? "";
    },
    getUnstagedNumstat() {
      track("getUnstagedNumstat");
      return stubs["getUnstagedNumstat"] ?? "";
    },
    getStagedFileDiff(file: string) {
      track("getStagedFileDiff", file);
      return stubs[`getStagedFileDiff:${file}`] ?? stubs["getStagedFileDiff"] ?? "";
    },
    getStagedFileDiffWithContext(file: string, contextLines: number) {
      track("getStagedFileDiffWithContext", file, contextLines);
      return stubs[`getStagedFileDiffWithContext:${file}`] ?? stubs["getStagedFileDiffWithContext"] ?? "";
    },
    getStagedFileNumstat(file: string) {
      track("getStagedFileNumstat", file);
      return stubs[`getStagedFileNumstat:${file}`] ?? stubs["getStagedFileNumstat"] ?? "";
    },
    getStagedFileSummaryLines() {
      track("getStagedFileSummaryLines");
      return stubs["getStagedFileSummaryLines"] ?? "";
    },
    getStagedDiffForPrompt() {
      track("getStagedDiffForPrompt");
      return stubs["getStagedDiffForPrompt"] ?? "";
    },
    refExists(ref: string) {
      track("refExists", ref);
      return stubs[`refExists:${ref}`] ?? stubs["refExists"] ?? true;
    },
    readFileFromRef(ref: string) {
      track("readFileFromRef", ref);
      return stubs[`readFileFromRef:${ref}`] ?? stubs["readFileFromRef"] ?? "";
    },
    getRecentCommitLines(n?: number) {
      track("getRecentCommitLines", n);
      return stubs["getRecentCommitLines"] ?? "";
    },
    getRecentCommitStyleHints(n?: number) {
      track("getRecentCommitStyleHints", n);
      return stubs["getRecentCommitStyleHints"] ?? "";
    },
    getLastCommitStats() {
      track("getLastCommitStats");
      return stubs["getLastCommitStats"] ?? null;
    },
    getChangedSymbolsFromStagedDiff() {
      track("getChangedSymbolsFromStagedDiff");
      return stubs["getChangedSymbolsFromStagedDiff"] ?? "";
    },
    stageFiles(files: string[]) {
      track("stageFiles", files);
    },
    createCommit(message: string) {
      track("createCommit", message);
    },
    _calls: calls,
  };

  return service;
}