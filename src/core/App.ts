import chalk from "chalk";
import clipboard from "clipboardy";

import { config } from "../config/config.js";
import { CommitGenerator } from "../commit/CommitGenerator.js";
import { ContextBuilder } from "../context/ContextBuilder.js";
import { GitService } from "../git/GitService.js";
import { createLLM } from "../llm/index.js";
import { StagingService } from "../staging/StagingService.js";
import { UI } from "../ui/UI.js";
import type { LLM } from "../llm/LLM.js";
import type { PRContext } from "../types/types.js";
import { PRGenerator } from "../commit/PRGenerator.js";
export class App {
  private readonly git: GitService;
  private readonly ai: LLM;
  private readonly staging: StagingService;
  private readonly context: ContextBuilder;
  private readonly generator: CommitGenerator;
  private readonly issueRefs: string[] | null;
  private readonly fastMode: boolean;

  constructor(fastMode = false) {
    this.fastMode = fastMode;
    this.git = new GitService(config);
    this.ai = createLLM(config);
    this.staging = new StagingService(this.git, config);
    this.context = new ContextBuilder(this.git, config);
    this.generator = new CommitGenerator(this.ai, config);
    this.issueRefs = this.parseIssueRefs();
  }

  parseIssueRefs(): string[] | null {
    const args = process.argv.slice(2);
    const nums = args.filter((arg) => /^\d+$/.test(arg));
    if (!nums.length) return null;
    return nums.map((num) => `#${num}`);
  }

  appendIssueRefs(message: string): string {
    if (!this.issueRefs) return message;
    return `${message}\n\nrefs ${this.issueRefs.join(", ")}`;
  }

  async run(): Promise<void> {
    if (this.fastMode) {
      return this.runFast();
    }
    while (true) {
      await this.staging.ensureStaged();

      const files = this.git.getStagedFiles();
      const ctx = this.context.build(files);
      let message = await this.generator.generate(files, ctx);

      while (true) {
        UI.render(message, config);

        const action = await UI.actionMenu(config);

        if (action === "commit") {
          const finalMessage = this.appendIssueRefs(message);
          this.git.commit(finalMessage);

          const stats = this.git.getLastCommitSummary();

          if (stats) {
            console.log(
              chalk.green(
                "\n✔  Commit created  " +
                  chalk.dim("(") +
                  `${chalk.cyan(stats.files)} files  ` +
                  `${chalk.green("+" + stats.insertions)}  ` +
                  `${chalk.red("-" + stats.deletions)}` +
                  chalk.dim(")"),
              ),
            );
          } else {
            console.log(chalk.green("\n✔  Commit created\n"));
          }

          process.exit(0);
        }

        if (action === "regen") {
          this.generator.extraInstruction = "";
          message = await this.generator.generate(files, ctx);
          continue;
        }

        if (action === "refine") {
          const text = await UI.refineInput(config);
          this.generator.extraInstruction = text;
          message = await this.generator.generate(files, ctx);
          continue;
        }

        if (action === "edit") {
          message = await UI.editMessage(message, config);
          continue;
        }

        if (action === "copy") {
          await clipboard.write(message);
          console.log(chalk.gray("\n✔ Copied to clipboard\n"));
          continue;
        }

        console.log(chalk.gray("\nCancelled\n"));
        process.exit(0);
      }
    }
  }

  private async runFast(): Promise<void> {
    this.git.add(["."]);

    const files = this.git.getStagedFiles();
    if (!files.trim()) {
      console.log(chalk.gray("\n  Nothing to commit\n"));
      process.exit(0);
    }

    const ctx = this.context.build(files);
    const message = await this.generator.generate(files, ctx);
    const finalMessage = this.appendIssueRefs(message);

    this.git.commit(finalMessage);

    const stats = this.git.getLastCommitSummary();
    if (stats) {
      console.log(
        chalk.green(
          "\n✔  Commit created  " +
            chalk.dim("(") +
            `${chalk.cyan(stats.files)} files  ` +
            `${chalk.green("+" + stats.insertions)}  ` +
            `${chalk.red("-" + stats.deletions)}` +
            chalk.dim(")"),
        ),
      );
    } else {
      console.log(chalk.green("\n✔  Commit created\n"));
    }

    process.exit(0);
  }

  buildPRContext(baseBranch: string = "origin/main"): PRContext {
    return this.context.buildPRContext(baseBranch);
  }

  async runPRInteractive(baseBranch?: string): Promise<void> {
    const selectedBaseBranch =
      baseBranch ??
      await UI.selectBranch(
        this.git.getAllBranches(),
        "Select base branch for PR:",
      );

    const prContext = this.buildPRContext(selectedBaseBranch);

    const prGenerator = new PRGenerator(this.ai, config);
    const { title, description } = await prGenerator.generate(prContext);

    while (true) {
      console.log(chalk.blue("=== Pull Request Preview ===\n"));
      console.log(chalk.green("Base:"), selectedBaseBranch);
      console.log(chalk.green("Title:"), title);
      console.log(chalk.green("Description:\n"), description);

      const action = await UI.prActionMenu();

      if (action === "copy") {
        await clipboard.write(`# ${title}\n\n${description}`);
        console.log(chalk.gray("\n✔ Copied PR to clipboard\n"));
        continue;
      }

      if (action === "create") {
        console.log(chalk.gray("\n✔ PR would be created via GitHub CLI here\n"));
        process.exit(0);
      }

      if (action === "cancel") {
        console.log(chalk.gray("\nCancelled\n"));
        process.exit(0);
      }
    }
  }
}
