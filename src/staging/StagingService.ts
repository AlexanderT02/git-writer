import { readFileSync, statSync } from "fs";

import type { AppConfig } from "../config/config.js";
import { GracefulExit } from "../errors.js";
import type { GitService } from "../git/GitService.js";
import type { DiffStats, StatusEntry } from "../types/types.js";
import { UI } from "../ui/UI.js";
import { groupFiles } from "./fileGrouper.js";
import {
  buildTreeRows,
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
        .map((line) => this.parseStatusLine(line))
        .filter((entry) => entry.file && entry.file !== ".")
      : [];

    const stagedDeletes = this.getStagedDeleteEntries();
    const deduped = this.dedupeEntries([...entries, ...stagedDeletes]);

    return this.detectRenames(deduped);
  }

  private parseStatusLine(line: string): StatusEntry {
    const xy = line.slice(0, 2);
    const rest = line.slice(3).trim();

    const file = rest.includes(" -> ")
      ? rest.split(" -> ").pop()?.trim() ?? rest
      : rest;

    const indexStatus = xy[0] ?? " ";
    const worktreeStatus = xy[1] ?? " ";
    const code = worktreeStatus !== " " ? worktreeStatus : indexStatus;

    const hasStagedChange = indexStatus !== " " && indexStatus !== "?";
    const hasUnstagedChange = worktreeStatus !== " ";
    const partial = hasStagedChange && hasUnstagedChange;

    return {
      file: normalizePath(file),
      code,
      ...(partial && { partial }),
    };
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

        return { file, code } as StatusEntry;
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
  private detectRenames(entries: StatusEntry[]): StatusEntry[] {
    const gitRenames = this.parseGitRenames();

    if (!gitRenames.length) {
      return this.coalesceMovesByBasename(entries);
    }

    const renamedOld = new Set(gitRenames.map((r) => r.oldFile));
    const renamedNew = new Set(gitRenames.map((r) => r.newFile));

    const filtered = entries.filter((entry) => {
      if (entry.code === "D" && renamedOld.has(entry.file)) return false;
      if ((entry.code === "?" || entry.code === "A") && renamedNew.has(entry.file)) return false;
      return true;
    });

    const renameEntries: StatusEntry[] = gitRenames.map((r) => ({
      code: "R",
      oldFile: r.oldFile,
      file: r.newFile,
      similarity: r.similarity,
    }));

    return [...filtered, ...renameEntries];
  }

  private parseGitRenames(): Array<{
    oldFile: string;
    newFile: string;
    similarity: number;
  }> {
    const raw = this.git.getRenameStatus();

    if (!raw) return [];

    const renames: Array<{
      oldFile: string;
      newFile: string;
      similarity: number;
    }> = [];

    for (const line of raw.split("\n").filter(Boolean)) {
      const match = line.match(/^R(\d+)\s+(.+)\s+(.+)$/);

      if (!match) continue;

      renames.push({
        similarity: Number(match[1]),
        oldFile: normalizePath(match[2]!),
        newFile: normalizePath(match[3]!),
      });
    }

    return renames;
  }

  /**
   * Fallback when git diff -M returns no renames (e.g. untracked files).
   * Matches deleted + added files by basename.
   */
  private coalesceMovesByBasename(entries: StatusEntry[]): StatusEntry[] {
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
        if (entry.code === "D" && usedDeleted.has(entry.file)) return false;

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

  getDiffStats(files: StatusEntry[]): Map<string, DiffStats> {
    const stats = new Map<string, DiffStats>();

    this.addNumstatEntries(stats, this.git.getStagedNumstat());
    this.addNumstatEntries(stats, this.git.getUnstagedNumstat());

    for (const file of files) {
      const path = normalizePath(file.file);

      if (stats.has(path)) continue;

      if (file.code === "?" || file.code === "A" || file.code === "R") {
        const add = this.countTextFileLines(path);

        if (add > 0) {
          stats.set(path, { add, del: 0 });
        }
      }
    }

    this.enrichWithHunkCounts(stats);

    return stats;
  }

  private addNumstatEntries(
    stats: Map<string, DiffStats>,
    raw: string,
  ): void {
    if (!raw) return;

    for (const line of raw.split("\n")) {
      const [add, del, ...nameParts] = line.split("\t");
      const name = normalizePath(nameParts.join("\t"));

      if (!name) continue;

      // git numstat reports "-\t-\tfile" for binary files
      if (add === "-") {
        stats.set(name, { add: 0, del: 0, binary: true });
        continue;
      }

      const previous = stats.get(name) ?? { add: 0, del: 0 };

      stats.set(name, {
        add: previous.add + Number(add || 0),
        del: previous.del + Number(del || 0),
        binary: false,
      });
    }
  }

  private enrichWithHunkCounts(stats: Map<string, DiffStats>): void {
    for (const [path, stat] of stats) {
      if (stat.binary) continue;

      const staged = this.git.getFileHunkCount(path, true);
      const unstaged = this.git.getFileHunkCount(path, false);
      const total = staged + unstaged;

      if (total > 0) {
        stat.hunks = total;
      }
    }
  }

  collectHunkHeaders(files: StatusEntry[]): Map<string, string[]> {
    const headers = new Map<string, string[]>();

    for (const file of files) {
      const path = normalizePath(file.file);

      if (file.code === "D" || file.code === "?" || file.code === "R") {
        continue;
      }

      const staged = this.git.getFileDiffHunkHeaders(path, true);
      const unstaged = this.git.getFileDiffHunkHeaders(path, false);
      const combined = [...new Set([...staged, ...unstaged])];

      if (combined.length > 0) {
        headers.set(path, combined);
      }
    }

    return headers;
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

  async ensureStaged(): Promise<void> {
    const staged = this.git.getStagedFileNames().trim();
    const files = this.parseStatusDetailed();

    if (!files.length && !staged) {
      UI.renderWorkingTreeClean();
      throw new GracefulExit(0);
    }

    const diffStats = this.getDiffStats(files);
    const hunkHeaders = this.collectHunkHeaders(files);
    const groups = groupFiles(
      { files, diffStats, hunkHeaders },
      this.config.staging.groupingThreshold,
    );

    UI.renderStagingSummary(files, Boolean(staged), diffStats);

    const choices = buildTreeRows(files, Boolean(staged), diffStats, groups);

    const selected = await treeCheckbox({
      message: this.config.staging.message,
      help: this.config.staging.help,
      rows: choices,
      pageSize: this.config.staging.pageSize,
      loop: this.config.staging.loop,
      groups,
      getWarnings: (selectedFiles) =>
        this.getSelectionWarnings(selectedFiles, diffStats),
    });

    if (selected.includes("__SKIP__")) {
      UI.renderUsingAlreadyStagedFiles();
      return;
    }

    if (selected.includes("__ALL__")) {
      this.git.stageFiles(
        this.expandStageFiles(
          files,
          files.map((file) => file.file),
        ),
      );

      UI.renderStagedAllFiles(files.length);
      return;
    }

    if (!selected.length) {
      UI.renderNothingSelected();
      throw new GracefulExit(0);
    }

    this.warnIfSelectedFilesArePartiallyStaged(selected, files);

    this.git.stageFiles(this.expandStageFiles(files, selected));

    UI.renderStagedSelectedFiles(selected.length);
  }

  private expandStageFiles(
    files: StatusEntry[],
    selectedFiles: string[],
  ): string[] {
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

  /**
   * Uses the partial flag set during parsing instead of re-querying git status.
   * Falls back to git status when entries are not available.
   */
  private warnIfSelectedFilesArePartiallyStaged(
    selectedFiles: string[],
    files?: StatusEntry[],
  ): void {
    const partialFiles = files
      ? this.getPartiallyStagedFromEntries(selectedFiles, files)
      : this.getPartiallyStagedFromGit(selectedFiles);

    if (!partialFiles.length) return;

    UI.renderPartiallyStagedSelectionWarning(partialFiles);
  }

  private getPartiallyStagedFromEntries(
    selectedFiles: string[],
    files: StatusEntry[],
  ): string[] {
    const selectedSet = new Set(selectedFiles.map(normalizePath));

    return files
      .filter((entry) => entry.partial && selectedSet.has(normalizePath(entry.file)))
      .map((entry) => entry.file);
  }

  private getPartiallyStagedFromGit(selectedFiles: string[]): string[] {
    const selectedSet = new Set(selectedFiles.map(normalizePath));
    const status = this.git.getWorkingTreeStatus();

    if (!status) return [];

    const partialFiles: string[] = [];

    for (const line of status.split("\n").filter(Boolean)) {
      if (line.length < 4) continue;

      const indexStatus = line[0];
      const worktreeStatus = line[1];
      const rest = line.slice(3).trim();

      const file = normalizePath(
        rest.includes(" -> ")
          ? rest.split(" -> ").pop()?.trim() ?? rest
          : rest,
      );

      const hasStagedChange = indexStatus !== " " && indexStatus !== "?";
      const hasUnstagedChange = worktreeStatus !== " ";

      if (selectedSet.has(file) && hasStagedChange && hasUnstagedChange) {
        partialFiles.push(file);
      }
    }

    return partialFiles;
  }

  private getSelectionWarnings(
    selectedFiles: string[],
    diffStats: Map<string, DiffStats>,
  ): string[] {
    const realFiles = selectedFiles.filter(
      (file) => file !== "__ALL__" && file !== "__SKIP__",
    );

    const warnings: string[] = [];

    let additions = 0;
    let deletions = 0;
    let binaryCount = 0;

    for (const file of realFiles) {
      const stats = diffStats.get(normalizePath(file));

      if (!stats) continue;

      if (stats.binary) {
        binaryCount++;
        continue;
      }

      additions += stats.add;
      deletions += stats.del;
    }

    const changedLines = additions + deletions;

    if (realFiles.length >= 20) {
      warnings.push(
        `${realFiles.length} files selected. This is a large commit; consider splitting it.`,
      );
    } else if (realFiles.length >= 10) {
      warnings.push(
        `${realFiles.length} files selected. Check if these changes belong in one commit.`,
      );
    }

    if (changedLines >= 1000) {
      warnings.push(
        `${changedLines} changed lines (+${additions}/-${deletions}). This is a very large context; the generated message may be less precise.`,
      );
    } else if (changedLines >= 400) {
      warnings.push(
        `${changedLines} changed lines (+${additions}/-${deletions}). Consider selecting fewer files for a more precise message.`,
      );
    }

    if (binaryCount > 0) {
      warnings.push(
        `${binaryCount} binary file${binaryCount !== 1 ? "s" : ""} selected. Binary content is not analyzed.`,
      );
    }

    return warnings;
  }
}
