import { describe, it, expect } from "vitest";
import { CostEstimator } from "../../src/stats/CostEstimator.js";
import type { UsageLLMCall, UsageEntry } from "../../src/types/types.js";

function makeLLMCall(overrides: Partial<UsageLLMCall> = {}): UsageLLMCall {
  return {
    role: "generation",
    provider: "openai",
    model: "gpt-4o-mini",
    tokens: {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
    },
    success: true,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    timestamp: "2025-01-01T00:00:00Z",
    command: "commit",
    provider: "openai",
    reasoningModel: "gpt-4o-mini",
    generationModel: "gpt-4o-mini",
    llmCalls: [],
    usedTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    fileCount: 1,
    branch: "main",
    success: true,
    ...overrides,
  };
}

describe("CostEstimator", () => {
  const estimator = new CostEstimator();

  describe("estimateCall", () => {
    it("calculates cost for a known OpenAI model", () => {
      const call = makeLLMCall({
        provider: "openai",
        model: "gpt-4o-mini",
        tokens: { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
      });
      const cost = estimator.estimateCall(call);
      // gpt-4o-mini: input=0.15/M, output=0.6/M
      expect(cost.inputUsd).toBeCloseTo(0.15, 2);
      expect(cost.outputUsd).toBeCloseTo(0.6, 2);
      expect(cost.totalUsd).toBeCloseTo(0.75, 2);
    });

    it("returns zero cost for Ollama provider", () => {
      const call = makeLLMCall({ provider: "ollama", model: "llama3.1" });
      const cost = estimator.estimateCall(call);
      expect(cost.totalUsd).toBe(0);
      expect(cost.inputUsd).toBe(0);
      expect(cost.outputUsd).toBe(0);
    });

    it("returns zero cost for unknown model", () => {
      const call = makeLLMCall({ provider: "openai", model: "unknown-model" });
      const cost = estimator.estimateCall(call);
      expect(cost.totalUsd).toBe(0);
    });

    it("accounts for cached tokens", () => {
      const call = makeLLMCall({
        provider: "openai",
        model: "gpt-4o-mini",
        tokens: {
          inputTokens: 1_000_000,
          outputTokens: 0,
          totalTokens: 1_000_000,
          cachedTokens: 500_000,
        },
      });
      const cost = estimator.estimateCall(call);
      // 500k billable input at 0.15/M = 0.075
      // 500k cached input at 0.075/M = 0.0375
      expect(cost.inputUsd).toBeCloseTo(0.075, 3);
      expect(cost.cachedInputUsd).toBeCloseTo(0.0375, 4);
      expect(cost.totalUsd).toBeCloseTo(0.1125, 4);
    });

    it("handles zero tokens", () => {
      const call = makeLLMCall({
        tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
      const cost = estimator.estimateCall(call);
      expect(cost.totalUsd).toBe(0);
    });
  });

  describe("estimateEntry", () => {
    it("sums costs across multiple LLM calls", () => {
      const entry = makeEntry({
        llmCalls: [
          makeLLMCall({
            provider: "openai",
            model: "gpt-4o-mini",
            tokens: { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 },
          }),
          makeLLMCall({
            provider: "openai",
            model: "gpt-4o-mini",
            tokens: { inputTokens: 2_000_000, outputTokens: 1_000_000, totalTokens: 3_000_000 },
          }),
        ],
      });
      const cost = estimator.estimateEntry(entry);
      // Call 1: input=0.15, output=0.30 → 0.45
      // Call 2: input=0.30, output=0.60 → 0.90
      // Total: 1.35
      expect(cost.totalUsd).toBeCloseTo(1.35, 2);
    });

    it("handles entry with no LLM calls", () => {
      const entry = makeEntry({ llmCalls: [] });
      const cost = estimator.estimateEntry(entry);
      expect(cost.totalUsd).toBe(0);
    });
  });

  describe("estimateEntries", () => {
    it("sums costs across multiple entries", () => {
      const entries = [
        makeEntry({
          llmCalls: [
            makeLLMCall({
              provider: "openai",
              model: "gpt-4o-mini",
              tokens: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
            }),
          ],
        }),
        makeEntry({
          llmCalls: [
            makeLLMCall({
              provider: "openai",
              model: "gpt-4o-mini",
              tokens: { inputTokens: 0, outputTokens: 1_000_000, totalTokens: 1_000_000 },
            }),
          ],
        }),
      ];
      const cost = estimator.estimateEntries(entries);
      // Entry 1: input=0.15
      // Entry 2: output=0.60
      expect(cost.totalUsd).toBeCloseTo(0.75, 2);
    });
  });

  describe("hasPrice", () => {
    it("returns true for known models", () => {
      expect(estimator.hasPrice("openai", "gpt-4o-mini")).toBe(true);
      expect(estimator.hasPrice("openai", "gpt-4o")).toBe(true);
    });

    it("returns false for unknown models", () => {
      expect(estimator.hasPrice("openai", "gpt-99")).toBe(false);
      expect(estimator.hasPrice("unknown", "model")).toBe(false);
    });

    it("returns false for Ollama (no pricing)", () => {
      expect(estimator.hasPrice("ollama", "llama3.1")).toBe(false);
    });
  });
});