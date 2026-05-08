import ora from "ora";
import type { AppConfig } from "../config/config.js";
import type { GitService } from "../git/GitService.js";
import type { LLM } from "../llm/LLM.js";
import type { CompactFileSummary, FileGroup, LLMUsage } from "../types/types.js";

export class ChangeGrouper {
  constructor(
    private readonly git: GitService,
    private readonly ai: LLM,
    private readonly config: AppConfig,
  ) {}

  /**
   * Collect compact diff summaries for all unstaged + untracked files.
   * Each summary contains the path, status, line stats, hunk headers
   * (which function/class was changed), and a handful of key changed lines.
   */
  collectSummaries(): CompactFileSummary[] {
    const summaries: CompactFileSummary[] = [];

    // Modified / deleted files from working tree
    const nameStatus = this.git.getUnstagedNameStatus();
    const numstat = this.git.getUnstagedNumstat();

    const numstatMap = this.parseNumstatLines(numstat);

    if (nameStatus) {
      for (const line of nameStatus.split("\n").filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        const status = (parts[0] ?? "")[0] ?? "";
        const file = parts[parts.length - 1] ?? "";

        if (!file) continue;

        const stats = numstatMap.get(file) ?? { add: 0, del: 0 };
        const hunkHeaders = this.git.getFileDiffHunkHeaders(file, false);
        const keyLines = this.git.getFileDiffKeyLines(file, false);

        summaries.push({
          path: file,
          status,
          additions: stats.add,
          deletions: stats.del,
          hunkHeaders,
          keyLines,
        });
      }
    }

    // Untracked (new) files — no diff available, but path is informative
    for (const file of this.git.getUntrackedFiles()) {
      if (summaries.some((s) => s.path === file)) continue;

      summaries.push({
        path: file,
        status: "A",
        additions: 0,
        deletions: 0,
        hunkHeaders: [],
        keyLines: [],
      });
    }

    return summaries;
  }

  /**
   * Collect compact diff summaries for already-staged files.
   */
  collectStagedSummaries(): CompactFileSummary[] {
    const summaries: CompactFileSummary[] = [];

    const nameStatus = this.git.getStagedNameStatus();
    const numstat = this.git.getStagedNumstat();
    const numstatMap = this.parseNumstatLines(numstat);

    if (nameStatus) {
      for (const line of nameStatus.split("\n").filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        const status = (parts[0] ?? "")[0] ?? "";
        const file = parts[parts.length - 1] ?? "";

        if (!file) continue;

        const stats = numstatMap.get(file) ?? { add: 0, del: 0 };
        const hunkHeaders = this.git.getFileDiffHunkHeaders(file, true);
        const keyLines = this.git.getFileDiffKeyLines(file, true);

        summaries.push({
          path: file,
          status,
          additions: stats.add,
          deletions: stats.del,
          hunkHeaders,
          keyLines,
        });
      }
    }

    return summaries;
  }

  /**
   * Ask the LLM to group the files into logical atomic commits.
   */
  async group(
    summaries: CompactFileSummary[],
  ): Promise<{ groups: FileGroup[]; usage?: LLMUsage }> {
    const prompt = this.buildGroupingPrompt(summaries);

    const spinner = ora("Grouping changes...").start();

    let result: Awaited<ReturnType<typeof this.ai.complete>>;

    try {
      result = await this.ai.complete(prompt);
    } finally {
      spinner.stop();
    }

    const groups = this.parseGroups(result.text, summaries);

    return { groups, usage: result.usage };
  }

  buildGroupingPrompt(summaries: CompactFileSummary[]): string {
    const fileBlocks = summaries
      .map((f) => {
        const lines = [
          `${f.status} ${f.path} (+${f.additions} -${f.deletions})`,
        ];

        if (f.hunkHeaders.length > 0) {
          lines.push(`  Changed: ${f.hunkHeaders.join(", ")}`);
        }

        if (f.keyLines.length > 0) {
          lines.push("  Key changes:");

          for (const l of f.keyLines) {
            lines.push(`    ${l}`);
          }
        }

        return lines.join("\n");
      })
      .join("\n\n");

    return `Group these changed files into logical atomic commits.

For each file you see:
- Status (M=modified, A=added, D=deleted, R=renamed), path, and line counts
- Which functions/classes were changed (from hunk headers)
- A few key changed lines showing intent

Rules:
- Each file must appear in exactly one group
- Related files (a component + its test + its styles) belong together
- Config and dependency changes can be grouped together
- Keep groups between 2 and ${this.config.grouping.maxGroups}
- Each group should represent one coherent logical change
- Order groups so independent changes (deps, config) come first

Respond ONLY with a JSON array, no markdown fences, no explanation:
[{"label":"short description","conventionalType":"feat","files":["path1","path2"]}]

Valid conventionalType values: feat, fix, refactor, perf, test, docs, chore, ci, build

Changed files:
${fileBlocks}`;
  }

  private parseGroups(
    response: string,
    summaries: CompactFileSummary[],
  ): FileGroup[] {
    const cleaned = response
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    let parsed: FileGroup[];

    try {
      parsed = JSON.parse(cleaned) as FileGroup[];
    } catch {
      // Fallback: put everything in one group
      return [
        {
          label: "all changes",
          conventionalType: "chore",
          files: summaries.map((s) => s.path),
        },
      ];
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [
        {
          label: "all changes",
          conventionalType: "chore",
          files: summaries.map((s) => s.path),
        },
      ];
    }

    // Validate: ensure every file from summaries is in exactly one group
    const allPaths = new Set(summaries.map((s) => s.path));
    const assignedPaths = new Set<string>();

    for (const group of parsed) {
      if (!Array.isArray(group.files)) {
        group.files = [];
      }

      for (const file of group.files) {
        assignedPaths.add(file);
      }
    }

    // Add any unassigned files to the last group
    const missing = [...allPaths].filter((p) => !assignedPaths.has(p));

    if (missing.length > 0) {
      parsed[parsed.length - 1]!.files.push(...missing);
    }

    // Remove empty groups
    return parsed.filter((g) => g.files.length > 0);
  }

  private parseNumstatLines(raw: string): Map<string, { add: number; del: number }> {
    const map = new Map<string, { add: number; del: number }>();

    if (!raw) return map;

    for (const line of raw.split("\n").filter(Boolean)) {
      const [addRaw, delRaw, ...nameParts] = line.split("\t");
      const name = nameParts.join("\t");

      if (!name || addRaw === "-") continue;

      map.set(name, {
        add: Number(addRaw ?? 0),
        del: Number(delRaw ?? 0),
      });
    }

    return map;
  }
}
