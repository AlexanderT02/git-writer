import { readFileSync, statSync } from "fs";
import chalk from "chalk";
import type { AppConfig } from "../config/config.js";
import type { DiffStats, StatusEntry } from "../types/types.js";
import type { GitService } from "../git/GitService.js";
import {
  buildTreeRows,
  formatStatusSummary,
  normalizePath,
  treeCheckbox,
} from "./treePrompt.js";

export class StagingService {
  constructor(
    private readonly git: GitService,
    private readonly config: AppConfig,
  ) {}

  parseStatusDetailed(): StatusEntry[] {
    const status = this.git.getWorkingTreeStatus();

    const entries = status
      ? status
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const xy = line.slice(0, 2);
          const rest = line.slice(3).trim();

          const file = rest.includes(" -> ")
            ? rest.split(" -> ").pop()?.trim() ?? rest
            : rest;

          const code = xy[1] !== " " ? xy[1] ?? "" : xy[0] ?? "";

          return {
            file: normalizePath(file),
            code,
          };
        })
        .filter((entry) => entry.file && entry.file !== ".")
      : [];

    const stagedDeletes = this.getStagedDeleteEntries();

    return this.coalesceMoves(this.dedupeEntries([...entries, ...stagedDeletes]));
  }

  private getStagedDeleteEntries(): StatusEntry[] {
    const status = this.git.getStagedNameStatus();

    if (!status) return [];

    return status
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [code, ...parts] = line.trim().split(/\s+/);
        const file = normalizePath(parts.join(" "));

        return {
          file,
          code,
        };
      })
      .filter((entry) => entry.code === "D" && entry.file && entry.file !== ".");
  }

  private dedupeEntries(entries: StatusEntry[]): StatusEntry[] {
    const seen = new Set<string>();

    return entries.filter((entry) => {
      const key = `${entry.code}:${entry.file}:${entry.oldFile ?? ""}`;

      if (seen.has(key)) return false;

      seen.add(key);
      return true;
    });
  }

  private coalesceMoves(entries: StatusEntry[]): StatusEntry[] {
    const deleted = entries.filter((entry) => entry.code === "D");
    const added = entries.filter(
      (entry) => entry.code === "?" || entry.code === "A",
    );

    const usedDeleted = new Set<string>();
    const usedAdded = new Set<string>();
    const moves: StatusEntry[] = [];

    for (const add of added) {
      const addBase = add.file.split("/").pop();

      const match = deleted.find((del) => {
        if (usedDeleted.has(del.file)) return false;

        const delBase = del.file.split("/").pop();

        return delBase === addBase;
      });

      if (!match) continue;

      usedDeleted.add(match.file);
      usedAdded.add(add.file);

      moves.push({
        code: "R",
        oldFile: match.file,
        file: add.file,
      });
    }

    return [
      ...entries.filter((entry) => {
        if (entry.code === "D" && usedDeleted.has(entry.file)) {
          return false;
        }

        if (
          (entry.code === "?" || entry.code === "A") &&
          usedAdded.has(entry.file)
        ) {
          return false;
        }

        return true;
      }),
      ...moves,
    ];
  }

  private expandStageFiles(files: StatusEntry[], selectedFiles: string[]): string[] {
    const selectedSet = new Set(selectedFiles.map(normalizePath));
    const stageFiles = new Set<string>();

    for (const file of files) {
      const path = normalizePath(file.file);

      if (!selectedSet.has(path)) continue;

      if (file.oldFile) {
        stageFiles.add(normalizePath(file.oldFile));
      }

      stageFiles.add(path);
    }

    return [...stageFiles];
  }

  getDiffStats(files: StatusEntry[]): Map<string, DiffStats> {
    const stats = new Map<string, DiffStats>();

    const addGitNumstat = (raw: string): void => {
      if (!raw) return;

      for (const line of raw.split("\n")) {
        const [add, del, ...nameParts] = line.split("\t");
        const name = normalizePath(nameParts.join("\t"));

        if (!name || add === "-") continue;

        const previous = stats.get(name) ?? { add: 0, del: 0 };

        stats.set(name, {
          add: previous.add + Number(add || 0),
          del: previous.del + Number(del || 0),
        });
      }
    };

    addGitNumstat(this.git.getStagedNumstat());
    addGitNumstat(this.git.getUnstagedNumstat());

    for (const file of files) {
      const path = normalizePath(file.file);

      if (stats.has(path)) continue;

      if (file.code === "?" || file.code === "A" || file.code === "R") {
        const add = this.countTextFileLines(path);

        if (add > 0) {
          stats.set(path, {
            add,
            del: 0,
          });
        }
      }
    }

    return stats;
  }

  countTextFileLines(file: string): number {
    try {
      const stat = statSync(file);

      if (!stat.isFile()) {
        return 0;
      }

      const content = readFileSync(file);

      if (content.includes(0)) {
        return 0;
      }

      const text = content.toString("utf8");

      if (!text.length) {
        return 0;
      }

      const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const withoutTrailingNewline = normalized.endsWith("\n")
        ? normalized.slice(0, -1)
        : normalized;

      if (!withoutTrailingNewline.length) {
        return 1;
      }

      return withoutTrailingNewline.split("\n").length;
    } catch {
      return 0;
    }
  }

  printSummary(files: StatusEntry[], stagedExists: boolean): void {
    const total = files.length;

    console.log("");
    console.log(
      chalk.bold("  Stage changes") +
        chalk.dim(`  ${total} file${total !== 1 ? "s" : ""} `) +
        formatStatusSummary(files),
    );

    if (stagedExists) {
      console.log(chalk.dim.italic("  ↳ staged changes already present"));
    }

    console.log("");
  }

  async ensureStaged(): Promise<void> {
    const staged = this.git.getStagedFileNames().trim();
    const files = this.parseStatusDetailed();

    if (!files.length && !staged) {
      console.log(chalk.gray("\n  ✔ Working tree clean\n"));
      process.exit(0);
    }

    this.printSummary(files, Boolean(staged));

    const diffStats = this.getDiffStats(files);
    const choices = buildTreeRows(files, Boolean(staged), diffStats);

    const selected = await treeCheckbox({
      message: this.config.staging.message,
      help: this.config.staging.help,
      rows: choices,
      pageSize: this.config.staging.pageSize,
      loop: this.config.staging.loop,
    });

    if (selected.includes("__SKIP__")) {
      console.log(chalk.green("\n  ✔ Using already staged files\n"));
      return;
    }

    if (selected.includes("__ALL__")) {
      this.git.stageFiles(this.expandStageFiles(files, files.map((file) => file.file)));

      console.log(
        chalk.green(
          `\n  ✔ Staged all ${files.length} file${
            files.length !== 1 ? "s" : ""
          }\n`,
        ),
      );

      return;
    }

    if (!selected.length) {
      console.log(chalk.red("\n  ✖ Nothing selected — aborting\n"));
      process.exit(0);
    }

    this.git.stageFiles(this.expandStageFiles(files, selected));

    console.log(
      chalk.green(
        `\n  ✔ Staged ${selected.length} file${
          selected.length !== 1 ? "s" : ""
        }\n`,
      ),
    );
  }
}
