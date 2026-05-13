import type { DiffStats, FileGroup, StatusEntry } from "../types/types.js";
import { normalizePath } from "./treePrompt.js";

// ---------------------------------------------------------------------------
// File grouping — clusters changed files into logical commit candidates.
//
// Strategy layers:
//   1. Status-based: pure renames, pure deletes → isolated groups
//   2. Symbol-based: files touching the same function/class → semantic groups
//   3. Directory-based: remaining files sharing a prefix → module groups
//
// A file may only appear in one group. Groups with fewer than 2 files are
// discarded — they don't add value as selection shortcuts.
// ---------------------------------------------------------------------------

export interface FileGroupingInput {
  files: StatusEntry[];
  diffStats: Map<string, DiffStats>;
  hunkHeaders: Map<string, string[]>;
}

/**
 * Attempts to split a set of changed files into logical groups that could
 * each become a separate commit. Returns an empty array when the file
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

  // Prefer semantic cross-file relationships before broad directory groups.
  collectSymbolGroups(input, assigned, groups);

  // Use directory groups as a fallback for remaining unassigned files.
  collectDirectoryGroups(input, assigned, groups);

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
      label: formatGroupLabel("Renames", paths),
      conventionalType: "refactor",
      files: paths,
    });
  }

  if (deletes.length >= 2) {
    const paths = deletes.map((f) => normalizePath(f.file));

    for (const p of paths) assigned.add(p);

    groups.push({
      label: formatGroupLabel("Deletions", paths),
      conventionalType: "chore",
      files: paths,
    });
  }
}

function collectSymbolGroups(
  { files, hunkHeaders }: FileGroupingInput,
  assigned: Set<string>,
  groups: FileGroup[],
): void {
  const remaining = files.filter(
    (f) => !assigned.has(normalizePath(f.file)),
  );

  if (remaining.length < 2) return;

  // Build a reverse index: symbol → files that touch it.
  const symbolToFiles = new Map<string, Set<string>>();

  for (const file of remaining) {
    const path = normalizePath(file.file);
    const headers = hunkHeaders.get(path) ?? [];

    for (const header of headers) {
      const symbol = extractSymbol(header);

      if (!symbol) continue;

      const set = symbolToFiles.get(symbol) ?? new Set<string>();
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
      conventionalType: inferConventionalType(symbol, paths),
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

  // Collect files per meaningful directory prefix.
  const byDir = new Map<string, string[]>();

  for (const file of remaining) {
    const path = normalizePath(file.file);
    const dir = getGroupDir(path);

    if (!dir) continue;

    const list = byDir.get(dir) ?? [];
    list.push(path);
    byDir.set(dir, list);
  }

  const candidates = [...byDir.entries()]
    .filter(([, paths]) => paths.length >= 2)
    .filter(([, paths]) => paths.length !== remaining.length)
    .sort(([, a], [, b]) => b.length - a.length);

  for (const [dir, paths] of candidates) {
    const availablePaths = paths.filter((p) => !assigned.has(p));

    if (availablePaths.length < 2) continue;

    for (const p of availablePaths) assigned.add(p);

    groups.push({
      label: formatGroupLabel(`${dir}/`, availablePaths),
      conventionalType: inferConventionalType(dir, availablePaths),
      files: availablePaths,
    });
  }
}

/**
 * Returns the first meaningful directory segment for grouping.
 * Skips common root directories such as "src" when a more specific
 * second-level directory is available.
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

function inferConventionalType(dir: string, paths: string[]): string {
  const haystack = [dir, ...paths].join("\n").toLowerCase();

  if (
    /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/.test(
      haystack,
    )
  ) {
    return "test";
  }

  if (/(^|\/)(docs?|documentation)(\/|$)|\.mdx?$/.test(haystack)) {
    return "docs";
  }

  if (/(^|\/)(\.github|\.circleci|ci|workflows)(\/|$)/.test(haystack)) {
    return "ci";
  }

  if (
    /(^|\/)(config|configs)(\/|$)|\.config\.[cm]?[jt]s$|package\.json|tsconfig|eslint|prettier/.test(
      haystack,
    )
  ) {
    return "chore";
  }

  return "feat";
}

function formatGroupLabel(
  base: string,
  paths: string[],
): string {
  return `${base} (${paths.length} files.`;
}

/**
 * Extracts a function/class/symbol name from a hunk header line.
 *
 * Typical inputs:
 *   "class UserService {"
 *   "function handleLogin("
 *   "export const API_URL"
 *   "private async withRetry<T>("
 *   "def build_prompt("
 *   "fn group_files("
 */
function extractSymbol(header: string): string {
  const patterns = [
    // class Foo, interface Foo, type Foo, enum Foo
    /\b(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,

    // function foo(), async function foo(), function* foo()
    /\b(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,

    // const foo =, let foo =, var foo =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,

    // methodName(...) {, async methodName(...) {
    /\b(?:public|private|protected|static|async|readonly|\s)*\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*[:{]/,

    // Python/Rust fallback
    /\b(?:def|fn)\s+([A-Za-z_$][\w$]*)/,
  ];

  for (const pattern of patterns) {
    const match = header.match(pattern);

    if (match?.[1]) return match[1];
  }

  return "";
}
