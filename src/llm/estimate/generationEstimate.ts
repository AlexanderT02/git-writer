import type { CommitContext, PRContext } from "../../types/types.js";
import type { CommitGenerator } from "../../generation/CommitGenerator.js";
import type { PRGenerator } from "../../generation/PRGenerator.js";
import { estimateLLMCall, estimateTokens } from "./tokenEstimate.js";

/**
 * Estimate the reasoning output size based on the actual diff complexity,
 * not a fixed constant. More files / bigger diffs → more reasoning.
 */
function estimateReasoningOutput(diffTokens: number, fileCount: number): number {
  const base = 300;
  const perFile = 40;
  const diffFactor = Math.min(diffTokens * 0.05, 600);

  return Math.round(base + fileCount * perFile + diffFactor);
}

export function estimateCommitTokens(
  generator: CommitGenerator,
  files: string,
  context: CommitContext,
): number {
  const fileCount = files.split("\n").filter(Boolean).length;
  const diffTokens = estimateTokens(context._diff);

  const reasoningPrompt = generator.buildReasoningPrompt(files, context);
  const reasoningOutputEst = estimateReasoningOutput(diffTokens, fileCount);
  const reasoningEstimate = estimateLLMCall(reasoningPrompt, reasoningOutputEst);

  // For the second pass we need to account for the reasoning text
  // that will be injected.  Use spaces instead of "x"-runs so the
  // character-to-token ratio stays realistic.
  const fakeReasoning = " a".repeat(reasoningEstimate.estimatedOutputTokens);

  const messagePrompt = generator.buildMessagePrompt(
    files,
    context,
    fakeReasoning,
  );

  // Commit messages are short — output is 150–350 tokens.
  const messageOutputEst = Math.min(350, 150 + fileCount * 20);
  const messageEstimate = estimateLLMCall(messagePrompt, messageOutputEst);

  return reasoningEstimate.totalTokens + messageEstimate.totalTokens;
}

export function estimatePRTokens(
  generator: PRGenerator,
  prContext: PRContext,
): number {
  const diffTokens = estimateTokens(prContext.diff);
  const commitCount = prContext.commits.split("\n").filter(Boolean).length;

  const reasoningPrompt = generator.buildReasoningPrompt(prContext);
  const reasoningOutputEst = Math.round(
    500 + commitCount * 60 + Math.min(diffTokens * 0.06, 800),
  );
  const reasoningEstimate = estimateLLMCall(reasoningPrompt, reasoningOutputEst);

  const fakeReasoning = " a".repeat(reasoningEstimate.estimatedOutputTokens);

  const messagePrompt = generator.buildMessagePrompt(fakeReasoning);

  // PR descriptions are longer than commits but still bounded.
  const messageOutputEst = Math.min(1200, 400 + commitCount * 50);
  const messageEstimate = estimateLLMCall(messagePrompt, messageOutputEst);

  return reasoningEstimate.totalTokens + messageEstimate.totalTokens;
}
