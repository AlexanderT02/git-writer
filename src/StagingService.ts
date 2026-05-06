import { execFileSync } from "child_process";
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
import type { DiffStats, StatusEntry } from "./types.js";
import type { GitService } from "./GitService.js";

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

interface TreeFileEntry extends StatusEntry {
  basename: string;
}

class TreeNode {
  children = new Map<string, TreeNode>();
  files: TreeFileEntry[] = [];

  constructor(readonly name: string) {}

  insert(entry: StatusEntry): void {
    const parts = entry.file.split("/");
    const basename = parts.pop() ?? entry.file;
    let node: TreeNode = this;

    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, new TreeNode(part));
      }

      node = node.children.get(part)!;
    }

    node.files.push({ ...entry, basename });
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

type TreeChoice = {
  type: "choice";
  value: string;
  render: (state: {
    marker: string;
    checked: boolean;
    active: boolean;
  }) => string;
};

type TreeSeparator = {
  type: "separator";
  name: string;
};

type TreeRow = TreeChoice | TreeSeparator;

interface TreeCheckboxConfig {
  message: string;
  rows: TreeRow[];
  pageSize?: number;
  loop?: boolean;
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

const treeCheckbox = createPrompt<string[], TreeCheckboxConfig>(
  (config, done) => {
    const rows = config.rows;
    const pageSize = config.pageSize ?? 25;
    const loop = config.loop ?? false;
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
      status === "idle"
        ? "\n" +
          chalk.dim("  ↑/↓ bewegen · Space auswählen · Enter bestätigen") +
          "\n"
        : "";

    const selectedCount = selected.size
      ? chalk.dim(` ${selected.size} selected`)
      : "";

    return `${prefix} ${message}${selectedCount}${help}\n${page}`;
  },
);

export class StagingService {
  constructor(private readonly git: GitService) {}

  parseStatusDetailed(): StatusEntry[] {
    const status = this.git.getStatus();
    if (!status) return [];

    return status
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const xy = line.slice(0, 2);
        const rest = line.slice(2).trim();
        const file = rest.includes(" -> ")
          ? rest.split(" -> ").pop()?.trim() ?? rest
          : rest;
        const code = xy[1] !== " " ? xy[1] ?? "" : xy[0] ?? "";

        return { file, code };
      });
  }

  getDiffStats(): Map<string, DiffStats> {
    const runNumstat = (args: string[]): string => {
      return execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    };

    try {
      let raw = "";

      try {
        raw = runNumstat(["diff", "--numstat", "HEAD"]);
      } catch {
        raw = runNumstat(["diff", "--numstat"]);
      }

      if (!raw) return new Map();

      const stats = new Map<string, DiffStats>();

      for (const line of raw.split("\n")) {
        const [add, del, ...nameParts] = line.split("\t");
        const name = nameParts.join("\t");

        if (add === "-") continue;

        stats.set(name, {
          add: Number(add),
          del: Number(del),
        });
      }

      return stats;
    } catch {
      return new Map();
    }
  }

  formatStats(add: number, del: number): string {
    const parts: string[] = [];

    if (add > 0) parts.push(chalk.green(`+${add}`));
    if (del > 0) parts.push(chalk.red(`-${del}`));

    return parts.length
      ? chalk.dim("(") + parts.join(chalk.dim("/")) + chalk.dim(")")
      : "";
  }

  buildTree(files: StatusEntry[]): TreeNode {
    const root = new TreeNode(".");

    for (const file of files) {
      root.insert(file);
    }

    root.sort();
    root.collapse();

    return root;
  }

  buildChoices(files: StatusEntry[], stagedExists: boolean): TreeRow[] {
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

    const root = this.buildTree(files);
    const diffStats = this.getDiffStats();

    choices.push({ type: "separator", name: " " });
    this.flattenNode(root, "", true, choices, diffStats);

    return choices;
  }

  flattenNode(
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

        this.flattenNode(item.child, childPrefix, false, choices, diffStats);
        return;
      }

      const file = item.entry;
      const { icon, color } = getStatus(file.code);
      const stats = diffStats.get(file.file);
      const statsStr = stats
        ? " " + this.formatStats(stats.add, stats.del)
        : "";

      choices.push({
        type: "choice",
        value: file.file,
        render: ({ marker }) =>
          chalk.dim(prefix + connector) +
          marker +
          " " +
          color(`${icon} ${file.basename}`) +
          statsStr,
      });
    });
  }

  printSummary(files: StatusEntry[], stagedExists: boolean): void {
    const total = files.length;
    const counts: Record<string, number> = {};

    for (const file of files) {
      counts[file.code] = (counts[file.code] ?? 0) + 1;
    }

    const parts: string[] = [];

    for (const [code, count] of Object.entries(counts)) {
      const { color } = getStatus(code);
      parts.push(color(`${count}${STATUS[code]?.icon ?? code}`));
    }

    console.log("");
    console.log(
      chalk.bold("  Stage changes") +
        chalk.dim(`  ${total} file${total !== 1 ? "s" : ""} `) +
        parts.join(chalk.dim(" ")),
    );

    if (stagedExists) {
      console.log(chalk.dim.italic("  ↳ staged changes already present"));
    }

    console.log("");
  }

  async ensureStaged(): Promise<void> {
    const staged = this.git.getStagedFiles().trim();
    const files = this.parseStatusDetailed();

    if (!files.length && !staged) {
      console.log(chalk.gray("\n  ✔ Working tree clean\n"));
      process.exit(0);
    }

    this.printSummary(files, Boolean(staged));

    const choices = this.buildChoices(files, Boolean(staged));

    const selected = await treeCheckbox({
      message: "Select files to stage",
      rows: choices,
      pageSize: 25,
      loop: false,
    });

    if (selected.includes("__SKIP__")) {
      console.log(chalk.green("\n  ✔ Using already staged files\n"));
      return;
    }

    if (selected.includes("__ALL__")) {
      this.git.add(files.map((file) => file.file));

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

    this.git.add(selected);

    console.log(
      chalk.green(
        `\n  ✔ Staged ${selected.length} file${
          selected.length !== 1 ? "s" : ""
        }\n`,
      ),
    );
  }
}