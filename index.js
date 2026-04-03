#!/usr/bin/env node
import { execSync, spawnSync } from "child_process";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import OpenAI from "openai";


class OpenAIClient {
  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      console.log(chalk.red.bold("\n✖ OPENAI_API_KEY not set\n"));
      process.exit(1);
    }

    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async streamCompletion(prompt, onToken) {
    const stream = await this.client.responses.stream({
      model: "gpt-4o-mini",
      input: prompt
    });

    let fullText = "";
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        fullText += event.delta;
        onToken(fullText);
      }
    }
    return fullText.trim();
  }

}


class GitService {
  getBranch() {
    return execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
  }

  getStatus() {
    return execSync("git status --porcelain").toString().trim();
  }

  getLastCommitSummary() {
    try {
      const output = execSync("git show --shortstat -1").toString().trim();
      const match = output.match(
        /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
      );
      if (!match) return null;
      return { files: match[1], insertions: match[2] || 0, deletions: match[3] || 0 };
    } catch {
      return null;
    }
  }

  getStagedFiles() {
    return execSync("git diff --cached --name-only").toString().trim();
  }

  // Last N commits as few-shot style examples
  getRecentCommits(n = 8) {
    try {
      return execSync(`git log --oneline -${n} --no-merges`).toString().trim();
    } catch {
      return "";
    }
  }

  // Extract branch name and any issue number embedded in it
  getBranchContext() {
    const branch = this.getBranch();
    const issueMatch = branch.match(/[/#-](\d{2,})/);
    return {
      branch,
      issue: issueMatch ? `#${issueMatch[1]}` : null
    };
  }

  // Derive language/tech hints from staged file extensions
  getFileTypeHints(stagedFiles) {
    const files = stagedFiles.split("\n").map(f => f.trim()).filter(Boolean);
    const hints = new Set();

    const extMap = {
      ".java":   "Java",
      ".kt":     "Kotlin",
      ".scala":  "Scala",
      ".ts":     "TypeScript",
      ".tsx":    "TypeScript/React",
      ".js":     "JavaScript",
      ".jsx":    "JavaScript/React",
      ".py":     "Python",
      ".go":     "Go",
      ".rs":     "Rust",
      ".rb":     "Ruby",
      ".php":    "PHP",
      ".cs":     "C#",
      ".cpp":    "C++",
      ".c":      "C",
      ".swift":  "Swift",
    };

    for (const file of files) {
      for (const [ext, lang] of Object.entries(extMap)) {
        if (file.endsWith(ext)) hints.add(lang);
      }
      if (file.match(/[Tt]est|[Ss]pec/))           hints.add("includes tests");
      if (file.match(/migration/i))                 hints.add("includes DB migration");
      if (file.endsWith(".md") || file.endsWith(".mdx")) hints.add("includes docs");
      if (file.match(/Dockerfile|docker-compose/i)) hints.add("Docker config");
      if (file.match(/\.ya?ml$/) && file.match(/ci|github|gitlab|pipeline/i)) hints.add("CI config");
      if (file.match(/pom\.xml|build\.gradle|package\.json|Cargo\.toml|go\.mod/)) hints.add("build/dep file");
    }

    return [...hints].join(", ");
  }

  // Extract changed symbol names (functions, methods, classes) from @@ hunk headers.
  // This works for Java, Python, Go, JS/TS, Ruby, Rust, etc. because git already
  // parses the nearest function/class name into the @@ line.
  getChangedSymbols() {
    try {
      const raw = execSync("git diff --cached --unified=0").toString();
      const symbols = new Set();

      // Match @@ -x,y +a,b @@ <symbol context>
      const hunkHeader = /^@@[^@]+@@\s*(.+)$/gm;
      let match;
      while ((match = hunkHeader.exec(raw)) !== null) {
        const ctx = match[1].trim();
        if (ctx && ctx.length < 120) symbols.add(ctx);
      }

      return [...symbols].slice(0, 30).join("\n");
    } catch {
      return "";
    }
  }

  getDiff() {
    const raw = execSync("git diff --cached").toString();
    const lines = raw.split("\n");

    if (lines.length <= 800) return raw;

    // Large diff: stat + hunk headers only (preserves semantic signal)
    console.log(chalk.yellow("⚠ Large diff — semantic summary mode\n"));

    try {
      const stat = execSync("git diff --cached --stat").toString().trim();
      // Pull all hunk headers: file names + changed symbol contexts
      const headers = execSync("git diff --cached --unified=0")
        .toString()
        .split("\n")
        .filter(l => l.startsWith("+++") || l.startsWith("@@"))
        .slice(0, 150)
        .join("\n");

      return `[CHANGED FILES]\n${stat}\n\n[CHANGED SYMBOLS & HUNKS]\n${headers}`;
    } catch {
      return execSync("git diff --cached --stat").toString();
    }
  }

  add(files) {
    spawnSync("git", ["add", "--", ...files], { stdio: "inherit" });
  }

  commit(message) {
    execSync("git commit -F -", {
      input: message,
      stdio: ["pipe", "ignore", "ignore"]
    });
  }
}


class UI {
  static render(msg) {
    console.clear();
    const border = chalk.dim("─".repeat(60));
    console.log("\n" + border);
    console.log(chalk.bold("  Generated Commit"));
    console.log(border + "\n");
    console.log(msg || chalk.dim("...generating"));
    console.log("\n" + border);
  }

  static async actionMenu() {
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "What do you want to do?",
        choices: [
          { name: " Commit",                  value: "commit"  },
          { name: " Edit message manually",   value: "edit"    },
          { name: " Regenerate",              value: "regen"   },
          { name: " Refine with instruction", value: "refine"  },
          { name: " Copy to clipboard",       value: "copy"    },
          new inquirer.Separator(),
          { name: "✖ Cancel",                 value: "cancel"  }
        ]
      }
    ]);
    return action;
  }

  static async refineInput() {
    const { text } = await inquirer.prompt([
      {
        type: "input",
        name: "text",
        message: "Refinement instruction",
        validate: v => v.trim() ? true : "Enter something"
      }
    ]);
    return text.trim();
  }

  static async editMessage(initial) {
    const { text } = await inquirer.prompt([
      {
        type: "editor",
        name: "text",
        message: "Edit commit message",
        default: initial
      }
    ]);
    return text.trim();
  }
}


class StagingService {
  constructor(git) {
    this.git = git;
  }

  getStatusLabel(code) {
    switch (code) {
      case "M":  return chalk.yellow("● modified  ");
      case "A":  return chalk.green("● added     ");
      case "D":  return chalk.red("● deleted   ");
      case "?":  return chalk.gray("● untracked ");
      case "R":  return chalk.cyan("● renamed   ");
      default:   return chalk.dim(code.padEnd(10));
    }
  }

  parseStatusDetailed() {
    const status = this.git.getStatus();
    if (!status) return [];

    return status.split("\n").map(line => {
      const xy   = line.slice(0, 2);
      const rest = line.slice(2).trim();
      const file = rest.includes(" -> ") ? rest.split(" -> ").pop().trim() : rest;
      const code = xy[1] !== " " ? xy[1] : xy[0];
      return { file, code };
    });
  }

  printSummary(files, stagedExists) {
    const total = files.length;
    console.log(chalk.bold("\nStage changes\n"));
    if (stagedExists) console.log(chalk.gray("↳ Using existing staged changes possible"));
    console.log(chalk.dim(`Detected ${total} changed file${total !== 1 ? "s" : ""}\n`));
  }

  buildChoices(files, stagedExists) {
    return [
      { name: chalk.cyan.bold("✔ Stage ALL changes"), value: "__ALL__" },
      ...(stagedExists
        ? [{ name: chalk.gray("↳ Use already staged files"), value: "__SKIP__" }]
        : []),
      new inquirer.Separator(chalk.dim("──────── Files ────────")),
      ...files.map(f => ({
        name:    `${this.getStatusLabel(f.code)} ${f.file}`,
        value:   f.file,
        checked: f.code !== "?"
      }))
    ];
  }

  async ensureStaged() {
    const staged = this.git.getStagedFiles().trim();
    const files  = this.parseStatusDetailed();

    if (!files.length && !staged) {
      console.log(chalk.gray("\n✔ Working tree clean\n"));
      process.exit(0);
    }

    this.printSummary(files, !!staged);

    const choices = this.buildChoices(files, !!staged);
    const { selected } = await inquirer.prompt([
      {
        type:     "checkbox",
        name:     "selected",
        message:  "Select files to stage",
        choices,
        pageSize: 15,
        loop:     false
      }
    ]);

    if (selected.includes("__SKIP__")) {
      console.log(chalk.green("\n✔ Using already staged files\n"));
      return;
    }

    if (selected.includes("__ALL__")) {
      this.git.add(files.map(f => f.file));
      console.log(chalk.green(`\n✔ Staged all ${files.length} file${files.length !== 1 ? "s" : ""}\n`));
      return;
    }

    if (!selected.length) {
      console.log(chalk.red("\n✖ Nothing staged — aborting\n"));
      process.exit(0);
    }

    this.git.add(selected);
    console.log(chalk.green(`\n✔ Staged ${selected.length} file${selected.length !== 1 ? "s" : ""}\n`));
  }
}


class CommitGenerator {
  constructor(ai) {
    this.ai               = ai;
    this.extraInstruction = "";
  }

  // ── Step 1: lean reasoning (max_tokens kept tiny → fast) ──────────────
  // Only passes the signal-rich parts: symbols, branch, file list.
  // Skips the full diff to keep this call short.
  buildReasoningPrompt(files, diff, context) {
    const { branch, issue, fileHints, changedSymbols } = context;

    // For reasoning we only need a diff sketch — first 60 lines is enough
    const diffSketch = diff.split("\n").slice(0, 60).join("\n");

    return `
      Analyse this git change in 2-3 sentences. Answer only:
      1. Primary intent (feat / fix / refactor / perf / test / docs / chore / ci)?
      2. Most specific scope (class name, module, subsystem)?
      3. If multiple concerns are staged, which is dominant?

      Branch: ${branch}${issue ? `  (issue: ${issue})` : ""}
      ${fileHints      ? `Technologies: ${fileHints}`          : ""}
      ${changedSymbols ? `Changed symbols:\n${changedSymbols}` : ""}

      Staged files:
      ${files}

      Diff (sketch):
      ${diffSketch}

      Respond with a plain paragraph. No commit message, no lists.
      `.trim();
  }

  // ── Step 2: message generation with full context + reasoning ──────────
  buildMessagePrompt(files, diff, context, reasoning) {
    const { branch, issue, fileHints, changedSymbols, recentCommits } = context;

    const breakingHint =
      diff.includes("BREAKING") || diff.includes("breaking change")
        ? "⚠ Only add BREAKING CHANGE footer if the diff shows a removed/changed public API or contract — not for internal refactors."
        : "";

    return `
      You are writing a git commit message. The intent has already been analysed.

      ──────────────────────────────────────────────
      INTENT ANALYSIS (ground your message in this)
      ──────────────────────────────────────────────
      ${reasoning}

      ──────────────────────────────────────────────
      OUTPUT FORMAT — Conventional Commits
      ──────────────────────────────────────────────
      <type>(<scope>): <short summary>

      - <concrete change #1>
      - <concrete change #2>
      ...

      [BREAKING CHANGE: <description>]   ← real API/contract breaks only

      Rules:
      - First line ≤ 72 chars, imperative mood, no period
      - type: feat | fix | refactor | perf | test | docs | chore | ci | build | revert
      - scope: single noun from the dominant changed class/module — omit if unclear
      - Each bullet names ONE specific thing: a method added, a class removed, a check introduced
      - Concrete verbs only: add, extract, remove, rename, replace, validate, wire, register, split, deprecate
      - FORBIDDEN words: update, improve, change, various, misc, consolidate, enhance, streamline, refine
      - Plain text only — no markdown, no code fences
      - Do NOT mention file names unless intrinsically meaningful (e.g. a migration file)
      - Do NOT invent behaviour absent from the diff
      - Do NOT add BREAKING CHANGE unless a public API/interface/contract changed
      ${breakingHint}

      ──────────────────────────────────────────────
      CONTEXT
      ──────────────────────────────────────────────
      Branch: ${branch}${issue ? `  (issue: ${issue})` : ""}
      ${fileHints ? `Technologies: ${fileHints}` : ""}
      ${recentCommits  ? `\nRecent commits (match their scope/style conventions):\n${recentCommits}` : ""}
      ${changedSymbols ? `\nChanged symbols:\n${changedSymbols}`                                     : ""}
      ${this.extraInstruction ? `\nUser instruction: ${this.extraInstruction}`                       : ""}

      ──────────────────────────────────────────────
      STAGED FILES
      ──────────────────────────────────────────────
      ${files}

      ──────────────────────────────────────────────
      DIFF
      ──────────────────────────────────────────────
      ${diff}

      Write the commit message now. Nothing else.
      `.trim();
  }

  async generate(files, diff, context = {}) {
    // Step 1 — reasoning (silent, fast: short prompt + short answer)
    const spinner = ora("Analysing intent...").start();
    let reasoning = "";
    try {
      reasoning = await this.ai.complete(
        this.buildReasoningPrompt(files, diff, context)
      );
    } catch {
      // non-fatal — continue without reasoning
    }
    spinner.text = "Generating commit message...";

    // Step 2 — streamed message (spinner stays alive, no extra pause)
    const result = await this.ai.streamCompletion(
      this.buildMessagePrompt(files, diff, context, reasoning),
      text => { spinner.stop(); UI.render(text); }
    );

    spinner.stop();

    return result
      .replace(/```[\s\S]*?\n/g, "")
      .replace(/```/g, "")
      .replace(/^plaintext\s*/i, "")
      .trim();
  }
}


class App {
  constructor() {
    this.git       = new GitService();
    this.ai        = new OpenAIClient();
    this.staging   = new StagingService(this.git);
    this.generator = new CommitGenerator(this.ai);
    this.issueRefs = this.parseIssueRefs();
  }

  parseIssueRefs() {
    const args = process.argv.slice(2);
    const nums = args.filter(a => /^\d+$/.test(a));
    if (!nums.length) return null;
    return nums.map(n => `#${n}`);
  }

  appendIssueRefs(message) {
    if (!this.issueRefs) return message;
    return `${message}\n\nrefs ${this.issueRefs.join(", ")}`;
  }

  buildContext(files) {
    return {
      recentCommits:  this.git.getRecentCommits(8),
      changedSymbols: this.git.getChangedSymbols(),
      fileHints:      this.git.getFileTypeHints(files),
      ...this.git.getBranchContext()  // { branch, issue }
    };
  }

  async run() {
    while (true) {
      await this.staging.ensureStaged();

      const files   = this.git.getStagedFiles();
      const diff    = this.git.getDiff();
      const context = this.buildContext(files);

      let message = await this.generator.generate(files, diff, context);

      while (true) {
        UI.render(message);

        const action = await UI.actionMenu();

        if (action === "commit") {
          const finalMessage = this.appendIssueRefs(message);
          this.git.commit(finalMessage);

          const stats = this.git.getLastCommitSummary();
          if (stats) {
            console.log(
              chalk.green(
                `\n✔  Commit created  ` +
                chalk.dim("(") +
                `${chalk.cyan(stats.files)} files  ` +
                `${chalk.green("+" + stats.insertions)}  ` +
                `${chalk.red("-" + stats.deletions)}` +
                chalk.dim(")")
              )
            );
          } else {
            console.log(chalk.green("\n✔  Commit created\n"));
          }
          process.exit(0);
        }

        if (action === "regen") {
          this.generator.extraInstruction = "";
          message = await this.generator.generate(files, diff, context);
          continue;
        }

        if (action === "refine") {
          const text = await UI.refineInput();
          this.generator.extraInstruction = text;
          message = await this.generator.generate(files, diff, context);
          continue;
        }

        if (action === "edit") {
          message = await UI.editMessage(message);
          continue;
        }

        if (action === "copy") {
          await import("clipboardy").then(m => m.default.write(message));
          console.log(chalk.gray("\n✔ Copied to clipboard\n"));
          continue;
        }

        console.log(chalk.gray("\nCancelled\n"));
        process.exit(0);
      }
    }
  }
}


// start
new App().run();
