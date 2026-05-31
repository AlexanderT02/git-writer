import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { execFileSync } from "child_process";
import { dirname, join } from "path";

type PRContextStateEntry = {
  headSha: string;
  updatedAt: string;
  prUrl?: string;
};

type PRContextStateData = Record<string, PRContextStateEntry>;

export class PRContextStateStore {
  private readonly filePath: string;

  constructor() {
    this.filePath = this.resolveStoragePath();
  }

  getHeadSha(currentBranch: string, baseBranch: string): string | undefined {
    if (!this.filePath) return undefined;

    const data = this.readData();
    const entry = data[this.buildKey(currentBranch, baseBranch)];
    return entry?.headSha;
  }

  setHeadSha(
    currentBranch: string,
    baseBranch: string,
    headSha: string,
    prUrl?: string,
  ): void {
    if (!this.filePath || !headSha) return;

    const data = this.readData();
    const key = this.buildKey(currentBranch, baseBranch);

    data[key] = {
      headSha,
      updatedAt: new Date().toISOString(),
      prUrl,
    };

    this.writeData(data);
  }

  private buildKey(currentBranch: string, baseBranch: string): string {
    const normalizedBase = baseBranch.replace(/^origin\//, "");
    return `${currentBranch}::${normalizedBase}`;
  }

  private resolveStoragePath(): string {
    try {
      const gitDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();

      const gwDir = join(gitDir, "git-writer");
      mkdirSync(gwDir, { recursive: true });
      return join(gwDir, "pr-context.json");
    } catch {
      return "";
    }
  }

  private readData(): PRContextStateData {
    if (!this.filePath || !existsSync(this.filePath)) {
      return {};
    }

    try {
      const raw = readFileSync(this.filePath, "utf8");
      if (!raw.trim()) return {};
      const parsed = JSON.parse(raw) as unknown;

      if (!parsed || typeof parsed !== "object") {
        return {};
      }

      return parsed as PRContextStateData;
    } catch {
      return {};
    }
  }

  private writeData(data: PRContextStateData): void {
    if (!this.filePath) return;

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      renameSync(tmpPath, this.filePath);
    } catch {
      // Best effort only.
    }
  }
}
