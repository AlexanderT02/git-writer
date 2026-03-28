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

    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
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
      const output = execSync("git show --shortstat -1")
        .toString()
        .trim();

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
    return execSync("git diff --cached --name-only").toString();
  }

  getDiff() {
    let diff = execSync("git diff --cached").toString();

    if (diff.split("\n").length > 800) {
      console.log(chalk.yellow("⚠ Large diff — summary mode\n"));
      diff = execSync("git diff --cached --stat").toString();
    }

    return diff;
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
          { name: " Commit", value: "commit" },
          { name: " Edit message manually", value: "edit" },
          { name: " Regenerate", value: "regen" },
          { name: " Refine with instruction", value: "refine" },
          { name: " Copy to clipboard", value: "copy" },
          new inquirer.Separator(),
          { name: "✖ Cancel", value: "cancel" }
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
      case "M":
        return chalk.yellow("● modified  ");
      case "A":
        return chalk.green("● added     ");
      case "D":
        return chalk.red("● deleted   ");
      case "?":
        return chalk.gray("● untracked ");
      case "R":
        return chalk.cyan("● renamed   ");
      default:
        return chalk.dim(code.padEnd(10));
    }
  }

  parseStatusDetailed() {
    const status = this.git.getStatus();
    if (!status) return [];

    return status.split("\n").map(line => {
      const xy = line.slice(0, 2);
      const rest = line.slice(2).trim();

      const file = rest.includes(" -> ")
        ? rest.split(" -> ").pop().trim()
        : rest;

      const code = xy[1] !== " " ? xy[1] : xy[0];

      return { file, code };
    });
  }

  printSummary(files, stagedExists) {
    const total = files.length;

    console.log(chalk.bold("\nStage changes\n"));

    if (stagedExists) {
      console.log(chalk.gray("↳ Using existing staged changes possible"));
    }

    console.log(
      chalk.dim(`Detected ${total} changed file${total !== 1 ? "s" : ""}\n`)
    );
  }

  buildChoices(files, stagedExists) {
    return [
      {
        name: chalk.cyan.bold("✔ Stage ALL changes"),
        value: "__ALL__"
      },
      ...(stagedExists
        ? [
            {
              name: chalk.gray("↳ Use already staged files"),
              value: "__SKIP__"
            }
          ]
        : []),
      new inquirer.Separator(chalk.dim("──────── Files ────────")),
      ...files.map(f => ({
        name: `${this.getStatusLabel(f.code)} ${f.file}`,
        value: f.file,
        checked: f.code !== "?" // default: tracked files selected
      }))
    ];
  }

  async ensureStaged() {
    const staged = this.git.getStagedFiles().trim();
    const files = this.parseStatusDetailed();

    if (!files.length && !staged) {
      console.log(chalk.gray("\n✔ Working tree clean\n"));
      process.exit(0);
    }

    this.printSummary(files, !!staged);

    const choices = this.buildChoices(files, !!staged);

    const { selected } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "selected",
        message: "Select files to stage",
        choices,
        pageSize: 15,
        loop: false
      }
    ]);

    if (selected.includes("__SKIP__")) {
      console.log(chalk.green("\n✔ Using already staged files\n"));
      return;
    }

    if (selected.includes("__ALL__")) {
      this.git.add(files.map(f => f.file));
      console.log(
        chalk.green(
          `\n✔ Staged all ${files.length} file${
            files.length !== 1 ? "s" : ""
          }\n`
        )
      );
      return;
    }

    if (!selected.length) {
      console.log(chalk.red("\n✖ Nothing staged — aborting\n"));
      process.exit(0);
    }

    this.git.add(selected);

    console.log(
      chalk.green(
        `\n✔ Staged ${selected.length} file${
          selected.length !== 1 ? "s" : ""
        }\n`
      )
    );
  }
}


class CommitGenerator {
  constructor(ai) {
    this.ai = ai;
    this.extraInstruction = "";
  }

  buildPrompt(files, diff) {
    return `
    Write exactly one git commit message.

    Rules:
    - Use Conventional Commits
    - Output plain text only
    - No markdown
    - No code blocks
    - No explanations
    - Use imperative mood
    - Keep the summary at 72 characters or less
    - Be specific and technical
    - Avoid vague words like update, improve, change

    Format:

    type(scope): short summary

    - what changed
    - how it was changed

    Guidance:
    - Pick the commit type from the actual intent of the diff
    - Infer scope from the changed files when possible
    - Focus on the most important change
    - Ignore trivial formatting-only edits
    - Use concrete verbs like extract, split, remove, validate, rename, streamline

    Files:
    ${files}

    Diff:
    ${diff}

    ${this.extraInstruction ? `Refine:\n${this.extraInstruction}` : ""}
    `;
  }

  async generate(files, diff) {
    const spinner = ora("Generating commit message...").start();

    const result = await this.ai.streamCompletion(
      this.buildPrompt(files, diff),
      text => UI.render(text)
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
    this.git = new GitService();
    this.ai = new OpenAIClient();
    this.staging = new StagingService(this.git);
    this.generator = new CommitGenerator(this.ai);
  }

  async run() {
  while (true) {
    await this.staging.ensureStaged();

    const files = this.git.getStagedFiles();
    const diff = this.git.getDiff();

    let message = await this.generator.generate(files, diff);

    while (true) {
      UI.render(message);

      const action = await UI.actionMenu();

      if (action === "commit") {
        this.git.commit(message);

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
        message = await this.generator.generate(files, diff);
        continue;
      }

      if (action === "refine") {
        const text = await UI.refineInput();
        this.generator.extraInstruction = text;
        message = await this.generator.generate(files, diff);
        continue;
      }

      if (action === "edit") {
        message = await UI.editMessage(message);
        continue;
      }

      if (action === "copy") {
        await import("clipboardy").then(m =>
          m.default.write(message)
        );
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