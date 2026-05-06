/**
 * Smart context builder — collects only the information that adds signal
 * for the current commit, scales budgets by file count, and avoids
 * sending redundant data to the model.
 */
export class ContextBuilder {
  constructor(git) {
    this.git = git;
  }

  /**
   * Build an optimised context object.
   * Cheap metadata is always included.
   * Expensive data (full file contents, symbol lists) is gated by heuristics.
   */
  build(files) {
    const fileList = files.split("\n").filter(Boolean);
    const fileCount = fileList.length;

    // ── always included (tiny, high value) ──────────────────────────
    const branchCtx = this.git.getBranchContext();
    const stagedStats = this.git.getStagedStats();
    const fileHints = this.git.getFileTypeHints(files);

    // ── conditional: file summaries ─────────────────────────────────
    // With 1 file the full-file context already tells the whole story.
    const stagedFileSummaries =
      fileCount > 1 ? this.git.getStagedFileSummaries() : "";

    // ── conditional: style hints ────────────────────────────────────
    // Only worthwhile when there are enough staged files that the model
    // might struggle to pick a scope / type without repo-level hints.
    const recentStyleHints =
      fileCount > 3 ? this.git.getRecentCommitStyleHints(12) : "";

    // ── recent commits (message prompt only, for style matching) ────
    const recentCommits = this.git.getRecentCommits(8);

    // ── conditional: changed symbols ────────────────────────────────
    // Useful as a quick index ONLY when the diff is large and
    // fullFileContext has to truncate heavily; otherwise redundant.
    const diff = this.git.getDiff();
    const isLargeDiff = diff.split("\n").length > 800;
    const changedSymbols = isLargeDiff ? this.git.getChangedSymbols() : "";

    // ── full file context (the main event) ──────────────────────────
    // Per-file char budget scales inversely with file count so the
    // total token cost stays roughly constant.
    const charsPerFile =
      fileCount === 1
        ? 20_000
        : fileCount <= 3
          ? 10_000
          : fileCount <= 8
            ? 5_000
            : 2_500;

    const fullFileContext = this.git.getFullFileContext(charsPerFile, 50_000);

    return {
      ...branchCtx,
      stagedStats,
      fileHints,
      stagedFileSummaries,
      recentStyleHints,
      recentCommits,
      changedSymbols,
      fullFileContext,
      _diff: diff, // kept for breakingHint detection in prompt builder
    };
  }
}