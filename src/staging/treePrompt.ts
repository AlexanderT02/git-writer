import chalk from "chalk";
import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isSpaceKey,
  isUpKey,
  useKeypress,
  usePagination,
  usePrefix,
  useState,
} from "@inquirer/core";
import type { DiffStats, StatusEntry } from "../types/types.js";

const STATUS: Record<
  string,
  { icon: string; color: (text: string) => string }
> = {
  M: { icon: "±", color: chalk.yellow },
  A: { icon: "+", color: chalk.green },
  D: { icon: "-", color: chalk.red },
  R: { icon: "→", color: chalk.cyan },
  "?": { icon: "?", color: chalk.gray },
};

const SELECT = {
  off: chalk.gray("◯"),
  on: chalk.green("●"),
};

const getStatus = (code: string) =>
  STATUS[code] ?? { icon: "·", color: chalk.dim };

export const normalizePath = (file: string): string =>
  file.replace(/\\/g, "/").replace(/[/\\]+$/, "");

export interface TreeFileEntry extends StatusEntry {
  basename: string;
}

export class TreeNode {
  children = new Map<string, TreeNode>();
  files: TreeFileEntry[] = [];

  constructor(readonly name: string) {}

  insert(entry: StatusEntry): void {
    const cleanFile = normalizePath(entry.file);
    const parts = cleanFile.split("/").filter(Boolean);
    const basename = parts.pop() ?? cleanFile;
    let node: TreeNode = this;

    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, new TreeNode(part));
      }

      node = node.children.get(part)!;
    }

    if (!basename) return;

    node.files.push({
      ...entry,
      file: cleanFile,
      basename,
    });
  }

  sort(): void {
    const statusOrder: Record<string, number> = {
      D: 0,
      A: 1,
      "?": 2,
      R: 3,
      M: 4,
    };

    this.files.sort(
      (a, b) =>
        (statusOrder[a.code] ?? 9) - (statusOrder[b.code] ?? 9) ||
        a.basename.localeCompare(b.basename),
    );

    const sorted = [...this.children.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );

    this.children = new Map(sorted);

    for (const child of this.children.values()) {
      child.sort();
    }
  }

  collapse(): void {
    for (const [key, child] of [...this.children.entries()]) {
      child.collapse();

      if (child.files.length === 0 && child.children.size === 1) {
        const [[grandKey, grandChild]] = [...child.children.entries()];
        this.children.delete(key);
        this.children.set(`${key}/${grandKey}`, grandChild);
      }
    }
  }
}

export type TreeChoice = {
  type: "choice";
  value: string;
  render: (state: {
    marker: string;
    checked: boolean;
    active: boolean;
  }) => string;
};

export type TreeSeparator = {
  type: "separator";
  name: string;
};

export type TreeRow = TreeChoice | TreeSeparator;

interface TreeCheckboxConfig {
  message: string;
  help: string;
  rows: TreeRow[];
  pageSize: number;
  loop: boolean;
}

const getFirstSelectableIndex = (rows: TreeRow[]): number =>
  rows.findIndex((row) => row.type === "choice");

const moveCursor = (
  rows: TreeRow[],
  active: number,
  direction: -1 | 1,
  loop: boolean,
): number => {
  if (!rows.length) return active;

  let next = active;

  while (true) {
    next += direction;

    if (next < 0) {
      if (!loop) return active;
      next = rows.length - 1;
    }

    if (next >= rows.length) {
      if (!loop) return active;
      next = 0;
    }

    if (rows[next]?.type === "choice") return next;
    if (next === active) return active;
  }
};

export const treeCheckbox = createPrompt<string[], TreeCheckboxConfig>(
  (config, done) => {
    const rows = config.rows;
    const pageSize = config.pageSize;
    const loop = config.loop;
    const firstSelectable = getFirstSelectableIndex(rows);

    const [status, setStatus] = useState<"idle" | "done">("idle");
    const [active, setActive] = useState<number>(firstSelectable);
    const [selected, setSelected] = useState<Set<string>>(
      () => new Set<string>(),
    );
    const prefix = usePrefix({ status });

    useKeypress((key) => {
      if (status !== "idle") return;

      if (isUpKey(key)) {
        setActive(moveCursor(rows, active, -1, loop));
        return;
      }

      if (isDownKey(key)) {
        setActive(moveCursor(rows, active, 1, loop));
        return;
      }

      if (isSpaceKey(key)) {
        const row = rows[active];
        if (!row || row.type !== "choice") return;

        const next = new Set(selected);

        if (next.has(row.value)) {
          next.delete(row.value);
        } else {
          next.add(row.value);
        }

        setSelected(next);
        return;
      }

      if (isEnterKey(key)) {
        setStatus("done");
        done([...selected]);
      }
    });

    const page = usePagination<TreeRow>({
      items: rows,
      active,
      pageSize,
      loop,
      renderItem: ({ item, isActive }) => {
        if (item.type === "separator") {
          return `  ${item.name}`;
        }

        const checked = selected.has(item.value);
        const marker = checked ? SELECT.on : SELECT.off;
        const line = item.render({ marker, checked, active: isActive });

        return isActive ? chalk.cyan("❯ ") + line : "  " + line;
      },
    });

    const message =
      status === "done" ? chalk.dim(config.message) : chalk.bold(config.message);

    const help =
      status === "idle" ? "\n" + chalk.dim(`  ${config.help}`) + "\n" : "";

    const selectedCount = selected.size
      ? chalk.dim(` ${selected.size} selected`)
      : "";

    return `${prefix} ${message}${selectedCount}${help}\n${page}`;
  },
);

export function buildTree(files: StatusEntry[]): TreeNode {
  const root = new TreeNode(".");

  for (const file of files) {
    root.insert(file);
  }

  root.sort();
  root.collapse();

  return root;
}

export function formatStats(add: number, del: number): string {
  const parts: string[] = [];

  if (add > 0) parts.push(chalk.green(`+${add}`));
  if (del > 0) parts.push(chalk.red(`-${del}`));

  return parts.length
    ? chalk.dim("(") + parts.join(chalk.dim("/")) + chalk.dim(")")
    : "";
}

export function buildTreeRows(
  files: StatusEntry[],
  stagedExists: boolean,
  diffStats: Map<string, DiffStats>,
): TreeRow[] {
  const choices: TreeRow[] = [
    {
      type: "choice",
      value: "__ALL__",
      render: ({ marker }) =>
        `${marker} ${chalk.cyan.bold("★ Stage all changes")}`,
    },
  ];

  if (stagedExists) {
    choices.push({
      type: "choice",
      value: "__SKIP__",
      render: ({ marker }) =>
        `${marker} ${chalk.gray("↳ use already staged files")}`,
    });
  }

  const root = buildTree(files);

  choices.push({ type: "separator", name: " " });
  flattenNode(root, "", true, choices, diffStats);

  return choices;
}

function flattenNode(
  node: TreeNode,
  prefix: string,
  isRoot: boolean,
  choices: TreeRow[],
  diffStats: Map<string, DiffStats>,
): void {
  const dirs = [...node.children.entries()];

  const allItems: Array<
    | { type: "dir"; name: string; child: TreeNode }
    | { type: "file"; entry: TreeFileEntry }
  > = [
    ...dirs.map(([name, child]) => ({
      type: "dir" as const,
      name,
      child,
    })),
    ...node.files.map((entry) => ({
      type: "file" as const,
      entry,
    })),
  ];

  allItems.forEach((item, idx) => {
    const isLast = idx === allItems.length - 1;
    const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
    const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");

    if (item.type === "dir") {
      choices.push({
        type: "separator",
        name: chalk.dim(prefix + connector) + chalk.bold(`${item.name}/`),
      });

      flattenNode(item.child, childPrefix, false, choices, diffStats);
      return;
    }

    const file = item.entry;
    const path = normalizePath(file.file);
    const { icon, color } = getStatus(file.code);
    const stats = diffStats.get(path);
    const statsStr = stats
      ? " " + formatStats(stats.add, stats.del)
      : "";

    choices.push({
      type: "choice",
      value: path,
      render: ({ marker }) =>
        chalk.dim(prefix + connector) +
        marker +
        " " +
        color(`${icon} ${file.basename}`) +
        statsStr,
    });
  });
}

export function formatStatusSummary(
  files: StatusEntry[],
): string {
  const counts: Record<string, number> = {};

  for (const file of files) {
    counts[file.code] = (counts[file.code] ?? 0) + 1;
  }

  const parts: string[] = [];

  for (const [code, count] of Object.entries(counts)) {
    const { color } = getStatus(code);
    parts.push(color(`${count}${STATUS[code]?.icon ?? code}`));
  }

  return parts.join(chalk.dim(" "));
}