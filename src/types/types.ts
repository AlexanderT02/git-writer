export type GitStatusCode = "M" | "A" | "D" | "R" | "?" | string;

export type LLMUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
};

export type LLMResult = {
  text: string;
  usage?: LLMUsage;
};

export type CommitGenerationResult = {
  message: string;
  usage: {
    reasoning?: LLMUsage;
    generation?: LLMUsage;
    totalTokens: number;
  };
};

export type PRGenerationResult = {
  title: string;
  description: string;
  usage: {
    reasoning?: LLMUsage;
    generation?: LLMUsage;
    totalTokens: number;
  };
};

export interface StatusEntry {
  file: string;
  code: GitStatusCode;
  basename?: string;
  oldFile?: string;
}

export interface StagedEntry {
  status: string;
  file: string;
}

export interface DiffStats {
  add: number;
  del: number;
}

export interface BranchContext {
  branch: string;
  issue: string | null;
}

export interface CommitStats {
  files: string;
  insertions: string | number;
  deletions: string | number;
}

export interface CommitContext extends BranchContext {
  stagedStats: string;
  stagedFileSummaries: string;
  recentStyleHints: string;
  recentCommits: string;
  changedSymbols: string;
  fileContext: string;
  _diff: string;
}

export interface FileContextResult {
  level: -1 | 0 | 1 | 2;
  text: string;
}

export type UiAction =
  | "commit"
  | "edit"
  | "regen"
  | "refine"
  | "copy"
  | "cancel";

export type PRContext = {
  branch: string;
  issue: string | null;
  commits: string;       
  diff: string;      
  fileContexts: string;  
};

export type BranchPRSummary = {
  branch: string;
  commits: number;
  files: number;
  insertions: number;
  deletions: number;
};

export type PullRequestCreateResult =
  | {
    status: "created";
    url: string;
    message: string;
  }
  | {
    status: "already_exists";
    url: string | null;
    message: string;
  }
  | {
    status: "not_pushed";
    message: string;
    suggestedCommand: string;
  }
  | {
    status: "unpushed_commits";
    message: string;
    suggestedCommand: string;
  }
  | {
    status: "gh_missing";
    message: string;
  }
  | {
    status: "gh_unauthenticated";
    message: string;
    suggestedCommand: string;
  }
  | {
    status: "failed";
    message: string;
  };

export interface CompactFileSummary {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  hunkHeaders: string[];
  keyLines: string[];
}

export interface FileGroup {
  label: string;
  conventionalType: string;
  files: string[];
}

export type UsageCommand = "commit" | "pr";

export type LLMCallRole = "reasoning" | "generation";

export interface UsageTokenDetails {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

export interface UsageLLMCall {
  role: LLMCallRole;
  provider: string;
  model: string;
  tokens: UsageTokenDetails;
  durationMs?: number;
  success: boolean;
  errorCode?: string;
}

export interface UsageEntry {
  timestamp: string;
  command: UsageCommand;

  provider: string;
  reasoningModel: string;
  generationModel: string;

  llmCalls: UsageLLMCall[];

  usedTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;

  fileCount: number;
  changedLines?: number;
  additions?: number;
  deletions?: number;

  branch: string;

  success: boolean;
  durationMs?: number;
  errorCode?: string;

  fastMode?: boolean;
}
