import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { execFileSync } from "child_process";
import type { UsageEntry } from "../types/types.js";
import { dirname, join } from "path";

export interface UsageData {
  entries: UsageEntry[];
}

export class UsageTracker {
  // Keep the stats file bounded. JSONL is append-friendly, but unlimited growth
  // would eventually make `gw stats` slower because it has to read all entries.
  private static readonly MAX_ENTRIES = 100_000;

  // Compaction requires reading the whole file, so do it only occasionally.
  // A value of 0.01 means roughly 1% of writes will check whether compaction is needed.
  private static readonly COMPACT_CHECK_RATE = 0.01;

  private readonly filePath: string;

  constructor() {
    this.filePath = this.resolveStoragePath();
  }

  private resolveStoragePath(): string {
    try {
      // Use --git-common-dir instead of --git-dir so worktrees share the same
      // repository-level stats directory.
      const gitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      const gwDir = join(gitDir, "git-writer");

      mkdirSync(gwDir, { recursive: true });

      return join(gwDir, "usage.jsonl");
    } catch {
      // Not inside a git repo, or git is unavailable. Stats become disabled.
      return "";
    }
  }

  record(entry: Omit<UsageEntry, "timestamp">): void {
    if (!this.filePath) return;

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });

      const fullEntry: UsageEntry = {
        ...entry,
        timestamp: new Date().toISOString(),
      };

      // JSONL keeps recording cheap: one append per usage event.
      appendFileSync(this.filePath, `${JSON.stringify(fullEntry)}\n`, "utf8");

      this.compactOccasionally();
    } catch {
      // Usage tracking should never break commits or PR creation.
    }
  }

  load(): UsageData {
    if (!this.filePath || !existsSync(this.filePath)) {
      return { entries: [] };
    }

    try {
      return {
        entries: this.readEntries(),
      };
    } catch {
      // A broken stats file should not break the CLI.
      return { entries: [] };
    }
  }

  clear(): void {
    if (!this.filePath) return;

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });

      // Keep the file itself in place, but remove all entries.
      writeFileSync(this.filePath, "", "utf8");
    } catch {
      // Best effort only.
    }
  }

  isAvailable(): boolean {
    return Boolean(this.filePath);
  }

  private readEntries(): UsageEntry[] {
    const raw = readFileSync(this.filePath, "utf8");

    if (!raw.trim()) {
      return [];
    }

    const entries: UsageEntry[] = [];
    const corruptLines: string[] = [];

    // JSONL allows partial recovery: one bad line does not invalidate the rest.
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();

      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);

        if (this.isUsageEntry(parsed)) {
          entries.push(parsed);
        } else {
          corruptLines.push(trimmed);
        }
      } catch {
        corruptLines.push(trimmed);
      }
    }

    // Preserve invalid lines for debugging instead of silently deleting them.
    if (corruptLines.length) {
      this.backupCorruptLines(corruptLines);
    }

    return entries;
  }

  private compactOccasionally(): void {
    // Avoid reading the whole JSONL file after every write.
    if (Math.random() > UsageTracker.COMPACT_CHECK_RATE) return;

    this.compactIfNeeded();
  }

  private compactIfNeeded(): void {
    const lineCount = this.countLines();

    if (lineCount <= UsageTracker.MAX_ENTRIES) return;

    // Keep the most recent valid entries and drop older ones.
    const entries = this.readEntries().slice(-UsageTracker.MAX_ENTRIES);

    this.writeEntriesAtomic(entries);
  }

  private countLines(): number {
    if (!existsSync(this.filePath)) return 0;

    const raw = readFileSync(this.filePath, "utf8");

    if (!raw) return 0;

    let count = 0;

    // Counting '\n' is cheaper than parsing JSON just to know whether compaction
    // might be needed.
    for (let i = 0; i < raw.length; i++) {
      if (raw.charCodeAt(i) === 10) {
        count++;
      }
    }

    return count;
  }

  private writeEntriesAtomic(entries: UsageEntry[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });

    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");

    // Write to a temporary file first, then rename. This avoids leaving a
    // half-written usage file if the process exits during compaction.
    writeFileSync(tmpPath, payload ? `${payload}\n` : "", "utf8");
    renameSync(tmpPath, this.filePath);
  }

  private backupCorruptLines(lines: string[]): void {
    if (!lines.length || !this.filePath) return;

    try {
      const path = `${this.filePath}.corrupt.${Date.now()}`;

      writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    } catch {
      // Best effort only.
    }
  }

  private isUsageEntry(value: unknown): value is UsageEntry {
    if (!value || typeof value !== "object") return false;

    const entry = value as Partial<UsageEntry>;

    return (
      typeof entry.timestamp === "string" &&
        (entry.command === "commit" || entry.command === "pr") &&
        typeof entry.provider === "string" &&
        typeof entry.reasoningModel === "string" &&
        typeof entry.generationModel === "string" &&
        Array.isArray(entry.llmCalls) &&
        entry.llmCalls.every((call) => this.isUsageLLMCall(call)) &&
        this.isFiniteNumber(entry.usedTokens) &&
        this.isFiniteNumber(entry.inputTokens) &&
        this.isFiniteNumber(entry.outputTokens) &&
        typeof entry.branch === "string" &&
        typeof entry.success === "boolean" &&
        this.isFiniteNumber(entry.fileCount) &&
        this.isOptionalFiniteNumber(entry.reasoningTokens) &&
        this.isOptionalFiniteNumber(entry.cachedTokens) &&
        this.isOptionalFiniteNumber(entry.changedLines) &&
        this.isOptionalFiniteNumber(entry.additions) &&
        this.isOptionalFiniteNumber(entry.deletions) &&
        this.isOptionalFiniteNumber(entry.durationMs) &&
        this.isOptionalString(entry.errorCode) &&
        this.isOptionalBoolean(entry.fastMode)
    );
  }

  private isUsageLLMCall(value: unknown): value is UsageEntry["llmCalls"][number] {
    if (!value || typeof value !== "object") return false;

    const call = value as Partial<UsageEntry["llmCalls"][number]>;

    return (
      (call.role === "reasoning" || call.role === "generation") &&
        typeof call.provider === "string" &&
        typeof call.model === "string" &&
        this.isUsageTokenDetails(call.tokens) &&
        typeof call.success === "boolean" &&
        this.isOptionalFiniteNumber(call.durationMs) &&
        this.isOptionalString(call.errorCode)
    );
  }

  private isUsageTokenDetails(value: unknown): value is UsageEntry["llmCalls"][number]["tokens"] {
    if (!value || typeof value !== "object") return false;

    const tokens = value as Partial<UsageEntry["llmCalls"][number]["tokens"]>;

    return (
      this.isFiniteNumber(tokens.inputTokens) &&
        this.isFiniteNumber(tokens.outputTokens) &&
        this.isFiniteNumber(tokens.totalTokens) &&
        this.isOptionalFiniteNumber(tokens.reasoningTokens) &&
        this.isOptionalFiniteNumber(tokens.cachedTokens)
    );
  }

  private isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
  }

  private isOptionalFiniteNumber(value: unknown): value is number | undefined {
    return value === undefined || this.isFiniteNumber(value);
  }

  private isOptionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === "string";
  }

  private isOptionalBoolean(value: unknown): value is boolean | undefined {
    return value === undefined || typeof value === "boolean";
  }
}
