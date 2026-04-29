#!/usr/bin/env node
import { execSync, spawnSync } from "child_process";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import OpenAI from "openai";


class OpenAIClient {
  static MODEL = "gpt-5.4-nano";

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      console.log(chalk.red.bold("\n✖ OPENAI_API_KEY not set\n"));
      process.exit(1);
    }

    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async complete(prompt) {
    const response = await this.client.responses.create({
      model: OpenAIClient.MODEL,
      input: prompt
    });

    return (response.output_text || "").trim();
  }

  async streamCompletion(prompt, onToken) {
    const stream = await this.client.responses.stream({
      model: OpenAIClient.MODEL,
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

      return {
        files: match[1],
        insertions: match[2] || 0,
        deletions: match[3] || 0
      };
    } catch {
      return null;
    }
  }

  getStagedFiles() {
    return execSync("git diff --cached --name-only").toString().trim();
  }

  getStagedFileSummaries() {
    try {
      const status = execSync("git diff --cached --name-status").toString().trim();
      if (!status) return "";

      return status
        .split("\n")
        .map(line => {
          const [status, ...rest] = line.trim().split(/\s+/);
          return `${status}: ${rest.join(" ")}`;
        })
        .join("\n");
    } catch {
      return "";
    }
  }

  getStagedStats() {
    try {
      return execSync("git diff --cached --shortstat").toString().trim();
    } catch {
      return "";
    }
  }

  getRecentCommits(n = 8) {
    try {
      return execSync(`git log --oneline -${n} --no-merges`).toString().trim();
    } catch {
      return "";
    }
  }

  getRecentCommitStyleHints(n = 12) {
    try {
      const commits = execSync(`git log --format=%s -${n} --no-merges`).toString().trim();
      if (!commits) return "";

      const scopes = new Set();
      const types = new Set();

      for (const line of commits.split("\n")) {
        const match = line.match(/^(\w+)(?:\(([^)]+)\))?:/);
        if (match) {
          types.add(match[1]);
          if (match[2]) scopes.add(match[2]);
        }
      }

      return [
        types.size ? `Recent commit types: ${[...types].join(", ")}` : "",
        scopes.size ? `Recent scopes: ${[...scopes].slice(0, 10).join(", ")}` : ""
      ].filter(Boolean).join("\n");
    } catch {
      return "";
    }
  }

  getBranchContext() {
    const branch = this.getBranch();
    const issueMatch = branch.match(/[/#-](\d{2,})/);

    return {
      branch,
      issue: issueMatch ? `#${issueMatch[1]}` : null
    };
  }

  getFileTypeHints(stagedFiles) {
    const files = stagedFiles.split("\n").map(f => f.trim()).filter(Boolean);
    const hints = new Set();

    const extMap = {
      ".java": "Java",
      ".kt": "Kotlin",
      ".scala": "Scala",
      ".ts": "TypeScript",
      ".tsx": "TypeScript/React",
      ".js": "JavaScript",
      ".jsx": "JavaScript/React",
      ".py": "Python",
      ".go": "Go",
      ".rs": "Rust",
      ".rb": "Ruby",
      ".php": "PHP",
      ".cs": "C#",
      ".cpp": "C++",
      ".c": "C",
      ".swift": "Swift"
    };

    for (const file of files) {
      for (const [ext, lang] of Object.entries(extMap)) {
        if (file.endsWith(ext)) hints.add(lang);
      }

      if (/[Tt]est|[Ss]pec/.test(file)) hints.add("includes tests");
      if (/migration/i.test(file)) hints.add("includes DB migration");
      if (file.endsWith(".md") || file.endsWith(".mdx")) hints.add("includes docs");
      if (/Dockerfile|docker-compose/i.test(file)) hints.add("Docker config");
      if (/\.ya?ml$/i.test(file) && /ci|github|gitlab|pipeline/i.test(file)) hints.add("CI config");
      if (/pom\.xml|build\.gradle|package\.json|Cargo\.toml|go\.mod/i.test(file)) hints.add("build/dep file");
    }

    return [...hints].join(", ");
  }

  getChangedSymbols() {
    try {
      const raw = execSync("git diff --cached --unified=0").toString();
      const symbols = new Set();

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

    if (lines.length <= 800) {
      return raw;
    }

    console.log(chalk.yellow("⚠ Large diff — semantic summary mode\n"));

    try {
      const stat = execSync("git diff --cached --stat").toString().trim();
      const headers = execSync("git diff --cached --unified=0")
        .toString()
        .split("\n")
        .filter(line => line.startsWith("+++") || line.startsWith("@@"))
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
    this.ai = ai;
    this.extraInstruction = "";
  }

  buildReasoningPrompt(files, diff, context) {
    const {
      branch,
      issue,
      fileHints,
      changedSymbols,
      stagedFileSummaries,
      stagedStats,
      recentStyleHints
    } = context;

    const diffSketch = diff.split("\n").slice(0, 80).join("\n");

    return `
Analyse staged git changes and identify the dominant commit intent.

Return exactly this format:

TYPE: <feat|fix|refactor|perf|test|docs|chore|ci|build|revert>
SCOPE: <single scope or NONE>
INTENT: <one sentence>
BULLETS:
- <specific change>
- <specific change>
- <specific change>

Rules:
- Pick the single dominant concern
- Use a narrow scope if clear, otherwise NONE
- Bullets must be concrete
- No code fences
- No markdown headings

Branch: ${branch}${issue ? ` (${issue})` : ""}
${fileHints ? `Technologies: ${fileHints}` : ""}
${stagedStats ? `Stats: ${stagedStats}` : ""}
${recentStyleHints ? `${recentStyleHints}` : ""}
${stagedFileSummaries ? `Staged file summary:\n${stagedFileSummaries}` : ""}
${changedSymbols ? `Changed symbols:\n${changedSymbols}` : ""}

Staged files:
${files}

Diff sketch:
${diffSketch}
    `.trim();
  }

  buildMessagePrompt(files, diff, context, reasoning) {
    const {
      branch,
      issue,
      fileHints,
      changedSymbols,
      recentCommits,
      recentStyleHints,
      stagedFileSummaries,
      stagedStats
    } = context;

    const breakingHint =
      diff.includes("BREAKING") || diff.includes("breaking change")
        ? "Only include BREAKING CHANGE if a public API, schema, interface, or contract truly changed."
        : "";

    return `
Write a Conventional Commit message from this analysis:

${reasoning}

Output format:
<type>(<scope>): <summary>

- <bullet>
- <bullet>

Optional:
BREAKING CHANGE: <description>

Rules:
- Summary max 72 chars
- Imperative mood
- No trailing period
- Scope only if helpful
- Prefer 2 bullets, max 3
- Bullets must be concrete and visible in staged changes
- Do not invent behavior
- Do not use vague words like: update, improve, change, misc, cleanup, various
- Prefer verbs like: add, remove, extract, rename, validate, wire, split, replace, handle
- Plain text only
${breakingHint}

Context:
Branch: ${branch}${issue ? ` (${issue})` : ""}
${fileHints ? `Technologies: ${fileHints}` : ""}
${stagedStats ? `Stats: ${stagedStats}` : ""}
${recentStyleHints ? `${recentStyleHints}` : ""}
${recentCommits ? `Recent commits:\n${recentCommits}` : ""}
${stagedFileSummaries ? `Staged file summary:\n${stagedFileSummaries}` : ""}
${changedSymbols ? `Changed symbols:\n${changedSymbols}` : ""}
${this.extraInstruction ? `User instruction: ${this.extraInstruction}` : ""}

Staged files:
${files}

Diff:
${diff}
    `.trim();
  }

  sanitizeCommitMessage(message) {
    return (message || "")
      .replace(/```[\s\S]*?\n/g, "")
      .replace(/```/g, "")
      .replace(/^plaintext\s*/i, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async generate(files, diff, context = {}) {
    const spinner = ora("Analysing intent...").start();

    let reasoning = "";
    try {
      reasoning = await this.ai.complete(
        this.buildReasoningPrompt(files, diff, context)
      );
    } catch {
      reasoning = "";
    }

    spinner.text = "Generating commit message...";

    const result = await this.ai.streamCompletion(
      this.buildMessagePrompt(files, diff, context, reasoning),
      text => {
        spinner.stop();
        UI.render(text);
      }
    );

    spinner.stop();
    return this.sanitizeCommitMessage(result);
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
    recentCommits: this.git.getRecentCommits(8),
    recentStyleHints: this.git.getRecentCommitStyleHints(12),
    changedSymbols: this.git.getChangedSymbols(),
    fileHints: this.git.getFileTypeHints(files),
    stagedFileSummaries: this.git.getStagedFileSummaries(),
    stagedStats: this.git.getStagedStats(),
    ...this.git.getBranchContext()
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
