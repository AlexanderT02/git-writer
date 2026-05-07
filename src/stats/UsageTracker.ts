import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import type { UsageEntry } from "../types/types.js";
import { join } from "path";

export interface UsageData {
  entries: UsageEntry[];
}

export class UsageTracker {
  private readonly filePath: string;

  constructor() {
    this.filePath = this.resolveStoragePath();
  }

  private resolveStoragePath(): string {
    try {
      const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      const gwDir = join(gitDir, "git-writer");

      if (!existsSync(gwDir)) {
        mkdirSync(gwDir, { recursive: true });
      }

      return join(gwDir, "usage.json");
    } catch {
      return "";
    }
  }

  record(entry: Omit<UsageEntry, "timestamp">): void {
    if (!this.filePath) return;

    try {
      const data = this.load();

      data.entries.push({
        ...entry,
        timestamp: new Date().toISOString(),
      });

      writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
    } catch {
      // Never block the main flow — stats are best-effort.
    }
  }

  load(): UsageData {
    if (!this.filePath || !existsSync(this.filePath)) {
      return { entries: [] };
    }

    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as UsageData;

      if (!Array.isArray(parsed.entries)) {
        return { entries: [] };
      }

      return parsed;
    } catch {
      return { entries: [] };
    }
  }

  clear(): void {
    if (!this.filePath) return;

    try {
      writeFileSync(this.filePath, JSON.stringify({ entries: [] }, null, 2), "utf8");
    } catch {
      // best-effort
    }
  }

  isAvailable(): boolean {
    return Boolean(this.filePath);
  }
}
