import type { LLMProviderName } from "../config/config.js";
import { LLMProviderError } from "../errors.js";

type ErrorLike = {
  status?: number;
  code?: string;
  message?: string;
};

export function requireProviderEnv(provider: LLMProviderName, name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new LLMProviderError(
      provider,
      "missing_api_key",
      `${provider}: missing ${name}`,
    );
  }

  return value;
}

export async function withLLMErrorHandling<T>(
  provider: LLMProviderName,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const err = error as ErrorLike;
    const message = err.message?.toLowerCase() ?? "";

    if (err.status === 401) {
      throw new LLMProviderError(
        provider,
        "auth",
        `${provider}: authentication failed`,
        error,
      );
    }

    if (err.status === 429) {
      const isQuota = message.includes("quota");

      throw new LLMProviderError(
        provider,
        isQuota ? "quota" : "rate_limit",
        isQuota
          ? `${provider}: quota exceeded`
          : `${provider}: rate limit exceeded`,
        error,
      );
    }

    if (err.status && err.status >= 500) {
      throw new LLMProviderError(
        provider,
        "provider",
        `${provider}: provider unavailable`,
        error,
      );
    }

    if (
      ["ECONNRESET", "ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT"].includes(
        err.code ?? "",
      )
    ) {
      throw new LLMProviderError(
        provider,
        "network",
        `${provider}: network error`,
        error,
      );
    }

    throw new LLMProviderError(
      provider,
      "unknown",
      `${provider}: request failed`,
      error,
    );
  }
}
