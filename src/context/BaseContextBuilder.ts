import type { AppConfig } from "../config/config.js";
import type { GitService } from "../git/GitService.js";

export type ContextLevel = -1 | 0 | 1 | 2;

export type ContextEntry = {
  status: string;
  file: string;
};

export type ContextResult = {
  level: ContextLevel;
  text: string;
};

export type ChangeSize = {
  additions: number;
  deletions: number;
  total: number;
  binary: boolean;
};

export abstract class BaseContextBuilder {
  protected constructor(
    protected readonly gitService: GitService,
    protected readonly config: AppConfig,
  ) {}

  protected getBudget(multiplier = 1): number {
    return this.config.context.tokenBudget * multiplier;
  }

  protected cost(text: string): number {
    return Math.ceil(text.length / 4);
  }

  protected getPerFileBudget(fileCount: number, totalBudget: number): number {
    if (fileCount <= 1) {
      return totalBudget;
    }

    const fairShare = Math.floor(totalBudget / fileCount);
    const softCap = Math.max(fairShare * 2, Math.floor(totalBudget * 0.25));

    return Math.max(1_000, softCap);
  }

  protected getContextLines(): number {
    return Math.max(0, Math.min(this.config.context.contextLines, 2));
  }

  protected prioritizeEntries<T extends ContextEntry>(entries: T[]): T[] {
    return [...entries].sort((a, b) => {
      const aPenalty = this.filePenalty(a.file);
      const bPenalty = this.filePenalty(b.file);

      if (aPenalty !== bPenalty) {
        return aPenalty - bPenalty;
      }

      const aSize = this.safeChangeSize(a).total;
      const bSize = this.safeChangeSize(b).total;

      return aSize - bSize;
    });
  }

  protected filePenalty(file: string): number {
    if (!file) return 100;

    if (
      /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i.test(
        file,
      )
    ) {
      return 50;
    }

    if (/\.min\.(js|css)$/i.test(file)) {
      return 40;
    }

    if (/(^|\/)(dist|build|coverage|vendor)\//i.test(file)) {
      return 35;
    }

    if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|mp4|mov)$/i.test(file)) {
      return 30;
    }

    return 0;
  }

  protected parseNameStatusLine(line: string): ContextEntry {
    const parts = line.trim().split(/\s+/);
    const rawStatus = parts[0] ?? "";
    const status = rawStatus[0] ?? "";
    const file = parts[parts.length - 1] ?? "";

    return { status, file };
  }

  protected skipped(entry: ContextEntry): ContextResult {
    return {
      level: -1,
      text: `[${entry.file}: skipped — budget exhausted]`,
    };
  }

  protected unknownFile(): ContextResult {
    return {
      level: -1,
      text: "[unknown file: skipped]",
    };
  }

  protected binary(entry: ContextEntry): ContextResult {
    return {
      level: -1,
      text: `=== ${entry.file} (${entry.status}) [binary] ===`,
    };
  }

  protected deleted(entry: ContextEntry, size?: ChangeSize): ContextResult {
    const suffix = size?.deletions
      ? `\nDeleted lines: ${size.deletions}`
      : "";

    return {
      level: 1,
      text: `=== ${entry.file} (${entry.status}) [deleted] ===\n--- DELETED FILE ---${suffix}`,
    };
  }

  protected noDiff(entry: ContextEntry): ContextResult {
    return {
      level: 0,
      text: `=== ${entry.file} (${entry.status}) [changed] ===\n[no diff]`,
    };
  }

  protected truncatedDiff(
    entry: ContextEntry,
    diffText: string,
    budget: number,
  ): ContextResult {
    const header = `=== ${entry.file} (${entry.status}) [truncated diff] ===\n`;
    const footer = "\n[truncated — budget exhausted]";

    const reservedChars = header.length + footer.length;
    const availableChars = Math.max(0, budget * 4 - reservedChars);

    if (availableChars <= 0) {
      return this.skipped(entry);
    }

    return {
      level: 0,
      text: `${header}${diffText.slice(0, availableChars)}${footer}`,
    };
  }

  protected parseNumstat(out: string): ChangeSize {
    const trimmed = out.trim();

    if (!trimmed) {
      return {
        additions: 0,
        deletions: 0,
        total: 0,
        binary: false,
      };
    }

    const [addedRaw = "0", deletedRaw = "0"] = trimmed.split(/\s+/);

    if (addedRaw === "-" && deletedRaw === "-") {
      return {
        additions: 0,
        deletions: 0,
        total: 0,
        binary: true,
      };
    }

    const additions = Number.parseInt(addedRaw, 10) || 0;
    const deletions = Number.parseInt(deletedRaw, 10) || 0;

    return {
      additions,
      deletions,
      total: additions + deletions,
      binary: false,
    };
  }

  protected shouldTryFullContext(
    entry: ContextEntry,
    size: ChangeSize,
    budget: number,
  ): boolean {
    if (budget <= 0) return false;

    const maxFullLines = Math.max(
      20,
      Math.floor(this.config.context.smallFileThreshold / 80),
    );

    if (entry.status === "A") {
      return size.additions > 0 && size.additions <= maxFullLines;
    }

    const maxModifiedLines = Math.max(12, Math.floor(maxFullLines / 2));

    return size.total > 0 && size.total <= maxModifiedLines;
  }

  private safeChangeSize(entry: ContextEntry): ChangeSize {
    try {
      return this.getChangeSize(entry.file);
    } catch {
      return {
        additions: Number.MAX_SAFE_INTEGER,
        deletions: 0,
        total: Number.MAX_SAFE_INTEGER,
        binary: false,
      };
    }
  }

  protected isContentExcluded(file: string): boolean {
    return this.config.context.excludedContentPatterns.some((pattern) =>
      this.matchesPattern(file, pattern),
    );
  }

  protected excluded(entry: ContextEntry): ContextResult {
    return {
      level: -1,
      text: `=== ${entry.file} (${entry.status}) [excluded] ===\n[content excluded by config]`,
    };
  }

  private matchesPattern(file: string, pattern: string): boolean {
    const normalizedFile = file.replace(/\\/g, "/");
    const normalizedPattern = pattern.replace(/\\/g, "/");

    if (normalizedPattern === normalizedFile) {
      return true;
    }

    if (!normalizedPattern.includes("*")) {
      return normalizedFile.endsWith(`/${normalizedPattern}`);
    }

    const regex = new RegExp(
      `^${normalizedPattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*")}$`,
    );

    return regex.test(normalizedFile);
  }

  protected abstract getChangeSize(file: string): ChangeSize;
}
