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
      stdio: ["pipe", "inherit", "inherit"]
    });
  }
}

class UI {
  static render(msg) {
    process.stdout.write("\x1Bc");

    const border = chalk.dim("─".repeat(50));
    console.log("\n" + border);
    console.log(chalk.bold.white("  COMMIT MESSAGE"));
    console.log(border + "\n");

    console.log("  " + msg);

    console.log("\n" + border);
    console.log(
      "  [Enter] commit   [r] regenerate   [r:<text>] refine   [n] cancel"
    );
    console.log(border + "\n");
  }

  static async selectFiles(choices) {
    const { selected } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "selected",
        message: "Pick files to stage",
        choices,
        pageSize: 12
      }
    ]);

    return selected;
  }

  static async getUserInput() {
    const { input } = await inquirer.prompt([
      { type: "input", name: "input", message: "›" }
    ]);

    return input.trim();
  }
}


class StagingService {
  constructor(git) {
    this.git = git;
  }

  parseStatus() {
    const status = this.git.getStatus();
    if (!status) return [];

    return status.split("\n").map(line => {
      const file = line.slice(2).trim();
      return file;
    });
  }

  async ensureStaged() {
    const staged = this.git.getStagedFiles().trim();
    const files = this.parseStatus();

    if (!files.length && !staged) {
      console.log(chalk.gray("Working tree clean\n"));
      process.exit(0);
    }

    const choices = [
      ...(staged ? [{ name: "→ Use staged", value: "__SKIP__" }] : []),
      ...files.map(f => ({ name: f, value: f }))
    ];

    const selected = await UI.selectFiles(choices);

    if (selected.includes("__SKIP__")) return;

    if (!selected.length) {
      console.log(chalk.red("Nothing staged — abort"));
      process.exit(0);
    }

    this.git.add(selected);
  }
}


class CommitGenerator {
  constructor(ai) {
    this.ai = ai;
    this.extraInstruction = "";
  }

  buildPrompt(files, diff) {
    return `
    You are a senior software engineer.

    Write EXACTLY ONE git commit message.

    STRICT RULES:
    - Use Conventional Commits
    - Output plain text only
    - NO markdown
    - NO code blocks
    - NO explanations
    - Use imperative mood
    - Be concise and technical
    - Max 72 chars for summary

    FORMAT:

    type(scope): short summary

    - specific change
    - reason for change
    - impact

    CONTEXT:

    Files:
    ${files}

    Diff:
    ${diff}

    ${this.extraInstruction ? `REFINE INSTRUCTION:\n${this.extraInstruction}` : ""}
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

      const message = await this.generator.generate(files, diff);

      const input = await UI.getUserInput();

      if (!input || input === "y") {
        this.git.commit(message);
        console.log(chalk.green("✔ Committed"));
        process.exit(0);
      }

      if (input === "r") {
        this.generator.extraInstruction = "";
        continue;
      }

      if (input.startsWith("r:")) {
        this.generator.extraInstruction = input.slice(2).trim();
        continue;
      }

      console.log("Cancelled");
      process.exit(0);
    }
  }
}


// start
new App().run();