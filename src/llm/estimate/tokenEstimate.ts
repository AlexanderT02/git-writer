export type TokenEstimate = {
  inputTokens: number;
  estimatedOutputTokens: number;
  totalTokens: number;
};

/**
 * Estimate token count from raw text.
 *
 * Instead of a single divisor we use a weighted blend:
 * code-heavy content (lots of symbols, short lines) tokenises
 * at roughly 2.8–3.2 chars/token while English prose sits
 * closer to 4.  We sample the text to decide which ratio to use.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const sample = text.slice(0, 4000);
  const codeSignals =
    (sample.match(/[{}()[\];=<>:,.|&!+\-*/\\@#~^%$?`]/g)?.length ?? 0) /
    sample.length;

  // Blend between prose ratio (4.0) and code ratio (2.8).
  const ratio = 4.0 - codeSignals * 6; // more symbols → lower ratio
  const clampedRatio = Math.max(2.5, Math.min(ratio, 4.0));

  return Math.ceil(text.length / clampedRatio);
}

/**
 * Estimate total tokens for a single LLM call.
 *
 * If no explicit output estimate is given, we derive one from
 * the input size — larger inputs usually produce larger outputs.
 */
export function estimateLLMCall(
  prompt: string,
  estimatedOutputTokens?: number,
): TokenEstimate {
  const inputTokens = estimateTokens(prompt);

  const outputTokens =
    estimatedOutputTokens ?? deriveOutputEstimate(inputTokens);

  return {
    inputTokens,
    estimatedOutputTokens: outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/**
 * Rough heuristic: output length scales sub-linearly with input.
 * Small prompts  → ~300–500 tokens output
 * Medium prompts → ~500–800
 * Large prompts  → ~800–1400
 */
function deriveOutputEstimate(inputTokens: number): number {
  if (inputTokens < 2000) return 400;
  if (inputTokens < 8000) return 600;
  if (inputTokens < 20000) return 900;

  return 1200;
}
