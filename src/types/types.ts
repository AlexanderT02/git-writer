export type GitStatusCode = "M" | "A" | "D" | "R" | "?" | string;

export interface StatusEntry {
  file: string;
  code: GitStatusCode;
  basename?: string;
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
