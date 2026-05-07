import type { CommitContext, PRContext } from "../types/types.js";
import type { CommitGenerator } from "../generation/CommitGenerator.js";
import type { PRGenerator } from "../generation/PRGenerator.js";
import { estimateLLMCall } from "./tokenEstimate.js";

export function estimateCommitTokens(
  generator: CommitGenerator,
  files: string,
  context: CommitContext,
): number {
  const reasoningPrompt = generator.buildReasoningPrompt(files, context);
  const reasoningEstimate = estimateLLMCall(reasoningPrompt, 700);

  const fakeReasoning = "x".repeat(reasoningEstimate.estimatedOutputTokens * 4);

  const messagePrompt = generator.buildMessagePrompt(
    files,
    context,
    fakeReasoning,
  );

  const messageEstimate = estimateLLMCall(messagePrompt, 350);

  return reasoningEstimate.totalTokens + messageEstimate.totalTokens;
}

export function estimatePRTokens(
  generator: PRGenerator,
  prContext: PRContext,
): number {
  const reasoningPrompt = generator.buildReasoningPrompt(prContext);
  const reasoningEstimate = estimateLLMCall(reasoningPrompt, 1200);

  const fakeReasoning = "x".repeat(reasoningEstimate.estimatedOutputTokens * 4);

  const messagePrompt = generator.buildMessagePrompt(fakeReasoning);
  const messageEstimate = estimateLLMCall(messagePrompt, 900);

  return reasoningEstimate.totalTokens + messageEstimate.totalTokens;
}
