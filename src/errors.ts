import type { LLMProviderName } from "./config/config.js";

export class GracefulExit extends Error {
  constructor(
    public readonly code: number = 0,
    message?: string,
  ) {
    super(message ?? `Process exit with code ${code}`);
    this.name = "GracefulExit";
  }
}

export class UserCancelledError extends GracefulExit {
  constructor() {
    super(0);
    this.name = "UserCancelledError";
  }
}

export type LLMProviderErrorKind =
  | "missing_api_key"
  | "auth"
  | "rate_limit"
  | "quota"
  | "network"
  | "provider"
  | "unknown";

export class LLMProviderError extends Error {
  constructor(
    readonly provider: LLMProviderName,
    readonly kind: LLMProviderErrorKind,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LLMProviderError";
  }
}
