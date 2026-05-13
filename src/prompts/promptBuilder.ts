import type { AppConfig } from "../config/config.js";
import type { CommitContext, PRContext } from "../types/types.js";

export interface CommitPromptInput {
  files: string;
  context: CommitContext;
  reasoning?: string;
  extraInstruction?: string;
}

export interface PRPromptInput {
  context: PRContext;
  reasoning?: string;
  extraInstruction?: string;
}

export interface CommitPromptBuilder {
  buildReasoningPrompt(input: CommitPromptInput, config: AppConfig): string;
  buildMessagePrompt(input: CommitPromptInput, config: AppConfig): string;
}

export interface PRPromptBuilder {
  buildReasoningPrompt(input: PRPromptInput, config: AppConfig): string;
  buildMessagePrompt(input: PRPromptInput, config: AppConfig): string;
}
