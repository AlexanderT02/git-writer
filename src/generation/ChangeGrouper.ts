import ora from "ora";
import type { AppConfig } from "../config/config.js";
import type { GitService } from "../git/GitService.js";
import type { LLM } from "../llm/LLM.js";
import type { CompactFileSummary, FileGroup, LLMUsage } from "../types/types.js";

type ParsedNameStatus = {
  status: string;
  path: string;
};

type EnrichedSummary = CompactFileSummary & {
  role: string;
  module: string;
  scope: string;
};

const VALID_CONVENTIONAL_TYPES = new Set([
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
    const summaries: CompactFileSummary[] = [];

    const nameStatus = this.git.getUnstagedNameStatus();
    const numstat = this.git.getUnstagedNumstat();
    const numstatMap = this.parseNumstatLines(numstat);

    for (const entry of this.parseNameStatusLines(nameStatus)) {
      const stats = numstatMap.get(entry.path) ?? { add: 0, del: 0 };
      const hunkHeaders = this.git.getFileDiffHunkHeaders(entry.path, false);
      const keyLines = this.git.getFileDiffKeyLines(entry.path, false);

      summaries.push({
        path: entry.path,
        status: entry.status,
        additions: stats.add,
        deletions: stats.del,
        hunkHeaders,
        keyLines,
      });
    }

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

    return summaries;
  }

  collectStagedSummaries(): CompactFileSummary[] {
    const summaries: CompactFileSummary[] = [];

    const nameStatus = this.git.getStagedNameStatus();
    const numstat = this.git.getStagedNumstat();
    const numstatMap = this.parseNumstatLines(numstat);

    for (const entry of this.parseNameStatusLines(nameStatus)) {
      const stats = numstatMap.get(entry.path) ?? { add: 0, del: 0 };
      const hunkHeaders = this.git.getFileDiffHunkHeaders(entry.path, true);
      const keyLines = this.git.getFileDiffKeyLines(entry.path, true);

      summaries.push({
        path: entry.path,
        status: entry.status,
        additions: stats.add,
        deletions: stats.del,
        hunkHeaders,
        keyLines,
      });
    }

    return summaries;
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
            label: this.labelFromSummary(only),
            conventionalType: this.inferConventionalType([only]),
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

    const groups = this.parseGroups(result.text, summaries);

    return { groups, usage: result.usage };
  }

  buildGroupingPrompt(summaries: CompactFileSummary[]): string {
    const enriched = summaries.map((summary) => this.enrichSummary(summary));
    const maxGroups = Math.min(
      this.config.grouping.maxGroups,
      Math.max(1, summaries.length),
    );

    const fileBlocks = enriched
      .map((file, index) => this.formatFileBlock(file, index + 1))
      .join("\n\n");

    const relatedHints = this.buildRelatedFileHints(enriched);

    return `You are in GROUPING JSON MODE.

Group changed files into logical atomic commits.

Goal:
Create groups that a maintainer would reasonably commit separately.

Grouping guidance:
- If all files belong to one logical change, return one group.
- Split only when changes are clearly independent.
- Keep source files with their direct tests.
- Keep components with related styles, stories, snapshots, and tests.
- Keep config, dependency, and lockfile changes together when they support the same change.
- Keep docs with the source change they describe, unless docs are unrelated.
- Avoid one-file groups unless the file is clearly unrelated.
- Prefer fewer coherent groups over many weak groups.

Hard rules:
- Every listed file must appear in exactly one group.
- Use only file paths from the changed files list.
- Do not invent files.
- Return between 1 and ${maxGroups} groups.
- Return valid JSON only.
- Do not use markdown fences.
- Do not include explanations.

JSON schema:
[
  {
    "label": "short description",
    "conventionalType": "feat|fix|refactor|perf|test|docs|chore|ci|build",
    "files": ["path/from/list"]
  }
]

Related-file hints:
${relatedHints || "None"}

Changed files:
${fileBlocks}`;
  }

  private formatFileBlock(file: EnrichedSummary, index: number): string {
    const lines = [
      `[${index}] ${file.status} ${file.path} (+${file.additions} -${file.deletions})`,
      `  role: ${file.role}`,
      `  module: ${file.module}`,
      `  scope: ${file.scope}`,
    ];

    if (file.hunkHeaders.length > 0) {
      lines.push(`  changed symbols: ${file.hunkHeaders.join(", ")}`);
    }

    if (file.keyLines.length > 0) {
      lines.push("  key changes:");

      for (const line of file.keyLines.slice(0, 8)) {
        lines.push(`    ${line}`);
      }
    }

    return lines.join("\n");
  }

  private parseGroups(
    response: string,
    summaries: CompactFileSummary[],
  ): FileGroup[] {
    const json = this.extractJsonArray(response);

    let parsed: unknown;

    try {
      parsed = JSON.parse(json);
    } catch {
      return this.fallbackGroups(summaries);
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return this.fallbackGroups(summaries);
    }

    const validPaths = new Set(summaries.map((summary) => summary.path));
    const assignedPaths = new Set<string>();
    const groups: FileGroup[] = [];

    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;

      const raw = item as Partial<FileGroup>;

      const files = Array.isArray(raw.files)
        ? raw.files.filter((file): file is string => {
          if (typeof file !== "string") return false;
          if (!validPaths.has(file)) return false;
          if (assignedPaths.has(file)) return false;

          assignedPaths.add(file);
          return true;
        })
        : [];

      if (files.length === 0) continue;

      groups.push({
        label:
          typeof raw.label === "string" && raw.label.trim()
            ? raw.label.trim()
            : "grouped changes",
        conventionalType: this.normalizeConventionalType(
          raw.conventionalType,
          files,
          summaries,
        ),
        files,
      });
    }

    const missing = summaries
      .map((summary) => summary.path)
      .filter((path) => !assignedPaths.has(path));

    if (missing.length > 0) {
      if (groups.length > 0) {
        groups[groups.length - 1]!.files.push(...missing);
      } else {
        return this.fallbackGroups(summaries);
      }
    }

    return groups.length > 0 ? groups : this.fallbackGroups(summaries);
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

  private fallbackGroups(summaries: CompactFileSummary[]): FileGroup[] {
    const enriched = summaries.map((summary) => this.enrichSummary(summary));
    const byModule = new Map<string, EnrichedSummary[]>();

    for (const summary of enriched) {
      const bucket = byModule.get(summary.module) ?? [];

      bucket.push(summary);
      byModule.set(summary.module, bucket);
    }

    if (byModule.size <= 1) {
      return [
        {
          label: "all changes",
          conventionalType: this.inferConventionalType(summaries),
          files: summaries.map((summary) => summary.path),
        },
      ];
    }

    return [...byModule.entries()].map(([module, files]) => ({
      label: `${module} changes`,
      conventionalType: this.inferConventionalType(files),
      files: files.map((file) => file.path),
    }));
  }

  private enrichSummary(summary: CompactFileSummary): EnrichedSummary {
    return {
      ...summary,
      role: this.inferRole(summary.path),
      module: this.inferModule(summary.path),
      scope: this.inferScope(summary.path),
    };
  }

  private inferRole(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    const fileName = normalized.split("/").pop() ?? normalized;

    if (normalized.startsWith(".github/workflows/")) return "ci";
    if (/(\.test|\.spec)\.[cm]?[jt]sx?$/.test(fileName)) return "test";
    if (normalized.includes("/__tests__/")) return "test";
    if (/\.stories\.[cm]?[jt]sx?$/.test(fileName)) return "story";
    if (/\.(css|scss|sass|less)$/.test(fileName)) return "style";
    if (/\.(md|mdx|rst)$/.test(fileName)) return "docs";

    if (
      /^(package.json|package-lock.json|pnpm-lock.yaml|yarn.lock|bun.lockb)$/.test(
        fileName,
      )
    ) {
      return "dependency";
    }

    if (
      /^(vite|webpack|rollup|tsup|eslint|prettier|vitest|jest|tsconfig)/.test(
        fileName,
      )
    ) {
      return "config";
    }

    if (/\.(json|yaml|yml|toml)$/.test(fileName)) return "config";
    if (/\.[cm]?[jt]sx?$/.test(fileName)) return "source";

    return "other";
  }

  private inferModule(path: string): string {
    const parts = path.replace(/\\/g, "/").split("/");

    if (parts.length === 1) return "root";

    if (parts[0] === "src" && parts[1]) return parts[1];
    if (parts[0] === "app" && parts[1]) return parts[1];
    if (parts[0] === "packages" && parts[1]) return `packages/${parts[1]}`;
    if (parts[0] === "apps" && parts[1]) return `apps/${parts[1]}`;

    return parts[0] ?? "root";
  }

  private inferScope(path: string): string {
    const normalized = path.replace(/\\/g, "/");

    if (normalized.includes("/generation/")) return "generation";
    if (normalized.includes("/context/")) return "context";
    if (normalized.includes("/git/")) return "git";
    if (normalized.includes("/llm/")) return "llm";
    if (normalized.includes("/ui/")) return "ui";
    if (normalized.includes("/stats/")) return "stats";
    if (normalized.includes("/config/")) return "config";
    if (normalized.includes("/tests/") || normalized.includes("/__tests__/")) {
      return "tests";
    }

    return this.inferModule(path);
  }

  private buildRelatedFileHints(summaries: EnrichedSummary[]): string {
    const byStem = new Map<string, string[]>();

    for (const summary of summaries) {
      const stem = this.fileStem(summary.path);
      const files = byStem.get(stem) ?? [];

      files.push(summary.path);
      byStem.set(stem, files);
    }

    return [...byStem.values()]
      .filter((files) => files.length > 1)
      .map((files) => `- ${files.join(" <-> ")}`)
      .join("\n");
  }

  private fileStem(path: string): string {
    return path
      .replace(/\\/g, "/")
      .replace(/\.test\.[cm]?[jt]sx?$/, "")
      .replace(/\.spec\.[cm]?[jt]sx?$/, "")
      .replace(/\.stories\.[cm]?[jt]sx?$/, "")
      .replace(/\.module\.css$/, "")
      .replace(/\.[^.]+$/, "")
      .replace("/__tests__/", "/")
      .replace("/tests/", "/")
      .replace("/styles/", "/");
  }

  private labelFromSummary(summary: CompactFileSummary): string {
    const enriched = this.enrichSummary(summary);

    return `${enriched.scope} changes`;
  }

  private normalizeConventionalType(
    value: unknown,
    files: string[],
    summaries: CompactFileSummary[],
  ): FileGroup["conventionalType"] {
    if (typeof value === "string" && VALID_CONVENTIONAL_TYPES.has(value)) {
      return value as FileGroup["conventionalType"];
    }

    const groupSummaries = summaries.filter((summary) =>
      files.includes(summary.path),
    );

    return this.inferConventionalType(groupSummaries);
  }

  private inferConventionalType(
    summaries: CompactFileSummary[],
  ): FileGroup["conventionalType"] {
    const enriched = summaries.map((summary) => this.enrichSummary(summary));
    const roles = new Set(enriched.map((summary) => summary.role));

    if (roles.size === 1 && roles.has("docs")) return "docs";
    if (roles.size === 1 && roles.has("test")) return "test";
    if (roles.size === 1 && roles.has("ci")) return "ci";

    if (roles.has("dependency")) return "build";
    if (roles.has("config")) return "chore";

    const keyText = enriched
      .flatMap((summary) => summary.keyLines)
      .join("\n")
      .toLowerCase();

    if (/\bfix|bug|error|exception|crash|regression|incorrect\b/.test(keyText)) {
      return "fix";
    }

    if (/\badd|create|new|enable|support\b/.test(keyText)) {
      return "feat";
    }

    return "chore";
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
