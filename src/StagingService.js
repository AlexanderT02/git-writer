import { execSync } from "child_process";
import chalk from "chalk";
import inquirer from "inquirer";

// status config
const STATUS = {
  M: { icon: "±", color: chalk.yellow },
  A: { icon: "+", color: chalk.green },
  D: { icon: "-", color: chalk.red },
  R: { icon: "→", color: chalk.cyan },
  "?": { icon: "?", color: chalk.gray },
};

const getStatus = (code) =>
  STATUS[code] || { icon: "·", color: chalk.dim };


class TreeNode {
  constructor(name) {
    this.name = name;
    this.children = new Map();
    this.files = [];
  }

  insert(entry) {
    const parts = entry.file.split("/");
    const basename = parts.pop();
    let node = this;

    for (const part of parts) {
      if (!node.children.has(part)) {
        node.children.set(part, new TreeNode(part));
      }
      node = node.children.get(part);
    }

    node.files.push({ ...entry, basename });
  }

  sort() {
    const statusOrder = { D: 0, A: 1, "?": 2, R: 3, M: 4 };

    this.files.sort(
      (a, b) =>
        (statusOrder[a.code] ?? 9) - (statusOrder[b.code] ?? 9) ||
        a.basename.localeCompare(b.basename),
    );

    const sorted = [...this.children.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    this.children = new Map(sorted);

    for (const child of this.children.values()) child.sort();
  }

  collapse() {
    for (const [key, child] of this.children) {
      child.collapse();

      if (child.files.length === 0 && child.children.size === 1) {
        const [grandKey, grandChild] = [...child.children.entries()][0];
        this.children.delete(key);
        this.children.set(`${key}/${grandKey}`, grandChild);
      }
    }
  }
}


// inquirer renders:
//   Choice:    "  ◯ {name}"    →  4 chars before name  (2 indent + circle + space)
//   Separator: "  {line}"      →  2 chars before line   (2 indent)
//
// To make tree connectors in choices align with separators, separators
// need 2 extra chars of padding so the tree content starts at the same
// column.
//
//   "  " + PAD + "├─ adapter/"           ← separator
//   "  ◯ "     + "├─ ± file.js"          ← choice (◯+space = 2 chars = PAD)
//
const PAD = "  ";

export class StagingService {
  constructor(git) {
    this.git = git;
  }

  parseStatusDetailed() {
    const status = this.git.getStatus();
    if (!status) return [];

    return status
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const xy = line.slice(0, 2);
        const rest = line.slice(2).trim();
        const file = rest.includes(" -> ")
          ? rest.split(" -> ").pop().trim()
          : rest;
        const code = xy[1] !== " " ? xy[1] : xy[0];
        return { file, code };
      });
  }

  getDiffStats() {
    try {
      const raw = execSync(
        "git diff --numstat HEAD 2>/dev/null || git diff --numstat",
      )
        .toString()
        .trim();

      if (!raw) return new Map();

      const stats = new Map();
      for (const line of raw.split("\n")) {
        const [add, del, ...nameParts] = line.split("\t");
        const name = nameParts.join("\t");
        if (add === "-") continue;
        stats.set(name, { add: Number(add), del: Number(del) });
      }
      return stats;
    } catch {
      return new Map();
    }
  }

  formatStats(add, del) {
    const parts = [];
    if (add > 0) parts.push(chalk.green(`+${add}`));
    if (del > 0) parts.push(chalk.red(`-${del}`));
    return parts.length
      ? chalk.dim("(") + parts.join(chalk.dim("/")) + chalk.dim(")")
      : "";
  }

  buildTree(files) {
    const root = new TreeNode(".");
    for (const f of files) root.insert(f);
    root.sort();
    root.collapse();
    return root;
  }

  
  buildChoices(files, stagedExists) {
    const choices = [
      {
        name: chalk.cyan.bold("★ Stage all changes"),
        value: "__ALL__",
      },
    ];

    if (stagedExists) {
      choices.push({
        name: chalk.gray("↳ use already staged files"),
        value: "__SKIP__",
      });
    }

    const root = this.buildTree(files);
    const diffStats = this.getDiffStats();

    choices.push(new inquirer.Separator(" "));
    this.flattenNode(root, "", true, choices, diffStats);

    return choices;
  }

  /**
   * Layout with PAD compensation:
   *
   *      ◯ ★ Stage all changes            ← choice
   *
   *        backend/src/main/java/          ← separator (PAD + tree)
   *        ├─ adapter/scheduler/           ← separator (PAD + tree)
   *      ◯ │  └─ ± AbstractPoller (+2)    ← choice  (tree in name)
   *        └─ domain/model/entity/         ← separator (PAD + tree)
   *      ◯    └─ ± Delivery.java (+3)     ← choice  (tree in name)
   *        frontend/src/composables/       ← separator (PAD + tree)
   *      ◯ └─ ± useFreighterStream (+2)   ← choice  (tree in name)
   *
   * The ◯ occupies 2 chars. Separators get PAD (2 spaces) to match.
   * Tree connectors align perfectly in both rows.
   */
  flattenNode(node, prefix, isRoot, choices, diffStats) {
    const dirs = [...node.children.entries()];
    const allItems = [
      ...dirs.map(([name, child]) => ({ type: "dir", name, child })),
      ...node.files.map((entry) => ({ type: "file", entry })),
    ];

    allItems.forEach((item, idx) => {
      const isLast = idx === allItems.length - 1;
      const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
      const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");

      if (item.type === "dir") {
        // Separator: add PAD so tree aligns with choice tree content
        choices.push(
          new inquirer.Separator(
            PAD +
              chalk.dim(prefix + connector) +
              chalk.bold(item.name + "/"),
          ),
        );
        this.flattenNode(item.child, childPrefix, false, choices, diffStats);
        return;
      }

      // Choice: ◯ takes 2 chars, tree goes directly in name
      const f = item.entry;
      const { icon, color } = getStatus(f.code);
      const stats = diffStats.get(f.file);
      const statsStr = stats
        ? " " + this.formatStats(stats.add, stats.del)
        : "";

      choices.push({
        name:
          chalk.dim(prefix + connector) +
          color(icon + " " + f.basename) +
          statsStr,
        value: f.file,
        checked: false,
      });
    });
  }

  printSummary(files, stagedExists) {
    const total = files.length;
    const counts = {};
    for (const f of files) counts[f.code] = (counts[f.code] || 0) + 1;

    const parts = [];
    for (const [code, count] of Object.entries(counts)) {
      const { color } = getStatus(code);
      parts.push(color(`${count}${STATUS[code]?.icon || code}`));
    }

    console.log("");
    console.log(
      chalk.bold("  Stage changes") +
        chalk.dim(`  ${total} file${total !== 1 ? "s" : ""} `) +
        parts.join(chalk.dim(" ")),
    );
    if (stagedExists)
      console.log(chalk.dim.italic("  ↳ staged changes already present"));
    console.log("");
  }

  async ensureStaged() {
    const staged = this.git.getStagedFiles().trim();
    const files = this.parseStatusDetailed();

    if (!files.length && !staged) {
      console.log(chalk.gray("\n  ✔ Working tree clean\n"));
      process.exit(0);
    }

    this.printSummary(files, Boolean(staged));

    const choices = this.buildChoices(files, Boolean(staged));
    const { selected } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "selected",
        message: "Select files to stage",
        choices,
        pageSize: 25,
        loop: false,
      },
    ]);

    if (selected.includes("__SKIP__")) {
      console.log(chalk.green("\n  ✔ Using already staged files\n"));
      return;
    }

    if (selected.includes("__ALL__")) {
      this.git.add(files.map((f) => f.file));
      console.log(
        chalk.green(
          `\n  ✔ Staged all ${files.length} file${files.length !== 1 ? "s" : ""}\n`,
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
        `\n  ✔ Staged ${selected.length} file${selected.length !== 1 ? "s" : ""}\n`,
      ),
    );
  }
}