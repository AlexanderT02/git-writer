import ora from "ora";
import type { AppConfig } from "../config/config.js";
import type { GitService } from "../git/GitService.js";
import type { LLM } from "../llm/LLM.js";
import type { CompactFileSummary, FileGroup, LLMUsage } from "../types/types.js";

type ParsedNameStatus = {
  status: string;
  path: string;
};

const VALID_CONVENTIONAL_TYPES = new Set<FileGroup["conventionalType"]>([
  "feat",
  "fix",
  "refactor",
  "perf",
  "test",
  "docs",
  "chore",
  "ci",
  "build",
]);

export class ChangeGrouper {
  constructor(
    private readonly git: GitService,
    private readonly ai: LLM,
    private readonly config: AppConfig,
  ) {}

  collectSummaries(): CompactFileSummary[] {
    return this.collectSummariesFromGit(false);
  }

  collectStagedSummaries(): CompactFileSummary[] {
    return this.collectSummariesFromGit(true);
  }

  async group(
    summaries: CompactFileSummary[],
  ): Promise<{ groups: FileGroup[]; usage?: LLMUsage }> {
    if (summaries.length === 0) {
      return { groups: [] };
    }

    if (summaries.length === 1) {
      const only = summaries[0]!;

      return {
        groups: [
          {
            label: "single file change",
            conventionalType: "chore",
            files: [only.path],
          },
        ],
      };
    }

    const prompt = this.buildGroupingPrompt(summaries);
    const spinner = ora("Grouping changes...").start();

    let result: Awaited<ReturnType<typeof this.ai.complete>>;

    try {
      result = await this.ai.complete(prompt);
    } finally {
      spinner.stop();
    }

    return {
      groups: this.parseGroups(result.text, summaries),
      usage: result.usage,
    };
  }

  buildGroupingPrompt(summaries: CompactFileSummary[]): string {
    const maxGroups = Math.min(
      this.config.grouping.maxGroups,
      Math.max(1, summaries.length),
    );

    const changedFiles = summaries
      .map((summary, index) => this.formatSummary(summary, index + 1))
      .join("\n\n");

    return `You are in GROUPING JSON MODE.

Group changed files into logical atomic commits.

Return valid JSON only. No markdown. No explanations.

Rules:
- Every listed file must appear exactly once.
- Use only exact paths from the changed files list.
- Return 1 to ${maxGroups} groups.
- Prefer fewer coherent groups.
- Split only when changes have clearly different intent.
- If one file has much larger changes than the others, consider putting it in its own group.
- Keep related source, tests, docs, styles, stories, fixtures, and types together.
- Keep config, dependency, lockfile, build, and workflow changes together when they support the same intent.
- Order groups in a sensible commit order: foundations first, then features/fixes, then tests/docs/cleanup.
- Choose a specific label that describes the intent.
- Choose the conventionalType from the group's actual purpose.

Types:
feat = new capability
fix = corrected behavior
refactor = internal restructuring
perf = performance change
test = tests only
docs = docs only
chore = maintenance/tooling
ci = CI workflow
build = package/build/release/dependency

Good example:
[
  {
    "label": "login state",
    "conventionalType": "refactor",
    "files": ["src/auth/useLogin.ts"]
  },
  {
    "label": "login flow",
    "conventionalType": "feat",
    "files": ["src/auth/LoginForm.tsx", "tests/auth/useLogin.test.ts"]
  },
  {
    "label": "release workflow",
    "conventionalType": "ci",
    "files": [".github/workflows/release.yml"]
  }
]

Avoid:
- one group per folder
- separating tests from their source without reason
- hiding one very large unrelated file inside a broad group
- vague labels like "misc", "updates", "core files"

Schema:
[
  {
    "label": "short intent",
    "conventionalType": "feat|fix|refactor|perf|test|docs|chore|ci|build",
    "files": ["exact/path/from/list"]
  }
]

Changed files:
${changedFiles}`;
  }

  private collectSummariesFromGit(staged: boolean): CompactFileSummary[] {
    const summaries: CompactFileSummary[] = [];

    const nameStatus = staged
      ? this.git.getStagedNameStatus()
      : this.git.getUnstagedNameStatus();

    const numstat = staged
      ? this.git.getStagedNumstat()
      : this.git.getUnstagedNumstat();

    const numstatMap = this.parseNumstatLines(numstat);

    for (const entry of this.parseNameStatusLines(nameStatus)) {
      const stats = numstatMap.get(entry.path) ?? { add: 0, del: 0 };

      summaries.push({
        path: entry.path,
        status: entry.status,
        additions: stats.add,
        deletions: stats.del,
        hunkHeaders: this.git.getFileDiffHunkHeaders(entry.path, staged),
        keyLines: this.git.getFileDiffKeyLines(entry.path, staged),
      });
    }

    if (!staged) {
      for (const file of this.git.getUntrackedFiles()) {
        if (summaries.some((summary) => summary.path === file)) continue;

        summaries.push({
          path: file,
          status: "A",
          additions: 0,
          deletions: 0,
          hunkHeaders: [],
          keyLines: [],
        });
      }
    }

    return summaries;
  }

  private formatSummary(summary: CompactFileSummary, index: number): string {
    const lines = [
      `[${index}] ${summary.status} ${summary.path} (+${summary.additions} -${summary.deletions})`,
    ];

    if (summary.hunkHeaders.length > 0) {
      lines.push(`changed symbols: ${summary.hunkHeaders.join(", ")}`);
    }

    if (summary.keyLines.length > 0) {
      lines.push("key changes:");

      for (const line of summary.keyLines.slice(0, 10)) {
        lines.push(`- ${line}`);
      }
    }

    return lines.join("\n");
  }

  private parseGroups(
    response: string,
    summaries: CompactFileSummary[],
  ): FileGroup[] {
    const parsed = this.parseJsonArray(response);
    const validPaths = new Set(summaries.map((summary) => summary.path));
    const assignedPaths = new Set<string>();
    const groups: FileGroup[] = [];

    for (const item of parsed) {
      const group = this.parseGroup(item, validPaths, assignedPaths);

      groups.push(group);
    }

    const missing = summaries
      .map((summary) => summary.path)
      .filter((path) => !assignedPaths.has(path));

    if (missing.length > 0) {
      throw new Error(
        `Failed to parse change groups: missing files: ${missing.join(", ")}`,
      );
    }

    return groups;
  }

  private parseGroup(
    item: unknown,
    validPaths: Set<string>,
    assignedPaths: Set<string>,
  ): FileGroup {
    if (!item || typeof item !== "object") {
      throw new Error("Failed to parse change groups: group must be an object");
    }

    const raw = item as {
      label?: unknown;
      conventionalType?: unknown;
      files?: unknown;
    };

    if (typeof raw.label !== "string" || !raw.label.trim()) {
      throw new Error("Failed to parse change groups: group label is missing");
    }

    if (
      typeof raw.conventionalType !== "string" ||
      !VALID_CONVENTIONAL_TYPES.has(raw.conventionalType as FileGroup["conventionalType"])
    ) {
      throw new Error(
        "Failed to parse change groups: invalid conventionalType",
      );
    }

    if (!Array.isArray(raw.files) || raw.files.length === 0) {
      throw new Error("Failed to parse change groups: files must be a non-empty array");
    }

    const files = raw.files.map((file) =>
      this.parseGroupFile(file, validPaths, assignedPaths),
    );

    return {
      label: raw.label.trim(),
      conventionalType: raw.conventionalType as FileGroup["conventionalType"],
      files,
    };
  }

  private parseGroupFile(
    file: unknown,
    validPaths: Set<string>,
    assignedPaths: Set<string>,
  ): string {
    if (typeof file !== "string") {
      throw new Error("Failed to parse change groups: file path must be a string");
    }

    if (!validPaths.has(file)) {
      throw new Error(`Failed to parse change groups: unknown file: ${file}`);
    }

    if (assignedPaths.has(file)) {
      throw new Error(`Failed to parse change groups: duplicate file: ${file}`);
    }

    assignedPaths.add(file);

    return file;
  }

  private parseJsonArray(response: string): unknown[] {
    const json = this.extractJsonArray(response);

    let parsed: unknown;

    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("Failed to parse change groups: response is not valid JSON");
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Failed to parse change groups: expected a non-empty JSON array");
    }

    return parsed;
  }

  private extractJsonArray(response: string): string {
    const cleaned = response
      .replace(/^```json\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");

    if (start === -1 || end === -1 || end <= start) {
      return cleaned;
    }

    return cleaned.slice(start, end + 1);
  }

  private parseNameStatusLines(raw: string): ParsedNameStatus[] {
    if (!raw) return [];

    const entries: ParsedNameStatus[] = [];

    for (const line of raw.split("\n").filter(Boolean)) {
      const parts = line.trim().split(/\s+/);
      const rawStatus = parts[0] ?? "";
      const status = rawStatus[0] ?? "";

      if (!status) continue;

      if (status === "R" || status === "C") {
        const target = parts[2] ?? parts[parts.length - 1];

        if (target) {
          entries.push({ status, path: target });
        }

        continue;
      }

      const file = parts[parts.length - 1];

      if (file) {
        entries.push({ status, path: file });
      }
    }

    return entries;
  }

  private parseNumstatLines(
    raw: string,
  ): Map<string, { add: number; del: number }> {
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
