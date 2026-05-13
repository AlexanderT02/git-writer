import type { DiffStats, FileGroup, StatusEntry } from "../types/types.js";
import { normalizePath } from "./treePrompt.js";

// ---------------------------------------------------------------------------
// File grouping — clusters changed files into logical commit candidates.
//
// Strategy layers (applied in priority order):
//   1. Status-based: pure renames, pure deletes → isolated groups
//   2. Directory-based: files sharing a common prefix → module groups
//   3. Symbol-based: files touching the same function/class (via hunk headers)
//
// A file may only appear in one group.  Groups with fewer than 2 files are
// discarded — they don't add value as selection shortcuts.
// ---------------------------------------------------------------------------

export interface FileGroupingInput {
  files: StatusEntry[];
  diffStats: Map<string, DiffStats>;
  hunkHeaders: Map<string, string[]>;
}

/**
 * Attempts to split a set of changed files into logical groups that could
 * each become a separate commit.  Returns an empty array when the file
 * count is below the threshold or no meaningful split is found.
 */
export function groupFiles(
  input: FileGroupingInput,
  threshold: number,
): FileGroup[] {
  const { files } = input;

  if (files.length < threshold) return [];

  const assigned = new Set<string>();
  const groups: FileGroup[] = [];

  collectStatusGroups(input, assigned, groups);
  collectDirectoryGroups(input, assigned, groups);
  collectSymbolGroups(input, assigned, groups);

  return groups.filter((g) => g.files.length >= 2);
}

function collectStatusGroups(
  { files }: FileGroupingInput,
  assigned: Set<string>,
  groups: FileGroup[],
): void {
  const renames = files.filter((f) => f.code === "R");
  const deletes = files.filter((f) => f.code === "D");

  if (renames.length >= 2) {
    const paths = renames.map((f) => normalizePath(f.file));

    for (const p of paths) assigned.add(p);

    groups.push({
      label: `Renames (${renames.length} files)`,
      conventionalType: "refactor",
      files: paths,
    });
  }

  if (deletes.length >= 2) {
    const paths = deletes.map((f) => normalizePath(f.file));

    for (const p of paths) assigned.add(p);

    groups.push({
      label: `Deletions (${deletes.length} files)`,
      conventionalType: "chore",
      files: paths,
    });
  }
}

function collectDirectoryGroups(
  { files }: FileGroupingInput,
  assigned: Set<string>,
  groups: FileGroup[],
): void {
  const remaining = files.filter(
    (f) => !assigned.has(normalizePath(f.file)),
  );

  if (remaining.length < 2) return;

  // Collect files per top-level directory (first meaningful path segment)
  const byDir = new Map<string, string[]>();

  for (const file of remaining) {
    const path = normalizePath(file.file);
    const dir = getGroupDir(path);

    if (!dir) continue;

    const list = byDir.get(dir) ?? [];
    list.push(path);
    byDir.set(dir, list);
  }

  for (const [dir, paths] of byDir) {
    if (paths.length < 2) continue;

    // Only create a directory group if it doesn't just contain every
    // remaining file — that would be the same as "stage all".
    if (paths.length === remaining.length) continue;

    for (const p of paths) assigned.add(p);

    groups.push({
      label: `${dir}/ (${paths.length} files)`,
      conventionalType: inferConventionalType(dir, paths),
      files: paths,
    });
  }
}

/**
 * Returns the first meaningful directory segment for grouping.
 * Skips "src" as sole prefix since almost everything lives under it.
 */
function getGroupDir(path: string): string {
  const parts = path.split("/").filter(Boolean);

  if (parts.length <= 1) return "";

  const first = parts[0]!;

  // If first segment is a common root like "src", "lib", "app", use the
  // next level so groups are more specific.
  if (/^(src|lib|app|packages)$/i.test(first) && parts.length > 2) {
    return `${first}/${parts[1]}`;
  }

  return first;
}

function inferConventionalType(dir: string, _paths: string[]): string {
  const lower = dir.toLowerCase();

  if (/test|spec|__tests__/.test(lower)) return "test";
  if (/doc|docs/.test(lower)) return "docs";
  if (/config|\.config/.test(lower)) return "chore";
  if (/ci|\.github|\.circleci/.test(lower)) return "ci";

  return "feat";
}

function collectSymbolGroups(
  { files, hunkHeaders }: FileGroupingInput,
  assigned: Set<string>,
  groups: FileGroup[],
): void {
  const remaining = files.filter(
    (f) => !assigned.has(normalizePath(f.file)),
  );

  if (remaining.length < 4) return;

  // Build a reverse index: symbol → files that touch it
  const symbolToFiles = new Map<string, Set<string>>();

  for (const file of remaining) {
    const path = normalizePath(file.file);
    const headers = hunkHeaders.get(path) ?? [];

    for (const header of headers) {
      const symbol = extractSymbol(header);

      if (!symbol) continue;

      const set = symbolToFiles.get(symbol) ?? new Set();
      set.add(path);
      symbolToFiles.set(symbol, set);
    }
  }

  // Find symbols that appear across multiple files — those are the
  // cross-cutting changes worth grouping.
  const candidates = [...symbolToFiles.entries()]
    .filter(([, paths]) => paths.size >= 2)
    .sort(([, a], [, b]) => b.size - a.size);

  for (const [symbol, pathSet] of candidates) {
    const paths = [...pathSet].filter((p) => !assigned.has(p));

    if (paths.length < 2) continue;

    for (const p of paths) assigned.add(p);

    groups.push({
      label: `${symbol} (${paths.length} files)`,
      conventionalType: "refactor",
      files: paths,
    });
  }
}

/**
 * Extracts a function/class name from a hunk header line.
 * Typical inputs:  "class UserService {", "function handleLogin(", "export const API_URL"
 */
function extractSymbol(header: string): string {
  const match = header.match(
    /(?:class|interface|function|enum|type|const|let|var|def|fn)\s+(\w+)/,
  );

  return match?.[1] ?? "";
}
