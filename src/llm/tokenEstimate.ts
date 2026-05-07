export type TokenEstimate = {
  inputTokens: number;
  estimatedOutputTokens: number;
  totalTokens: number;
};

export function estimateTokens(text: string): number {
  // Conservative rough estimate for code/diffs.
  // English prose is often ~4 chars/token, code/diffs can be denser.
  return Math.ceil(text.length / 3.5);
}

export function estimateLLMCall(
  prompt: string,
  estimatedOutputTokens = 500,
): TokenEstimate {
  const inputTokens = estimateTokens(prompt);

  return {
    inputTokens,
    estimatedOutputTokens,
    totalTokens: inputTokens + estimatedOutputTokens,
  };
}
