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

export class App {
  private readonly git: GitService;
  private readonly ai: LLM;
  private readonly staging: StagingService;
  private readonly context: ContextBuilder;
  private readonly generator: CommitGenerator;
  private readonly issueRefs: string[] | null;

  constructor() {
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
}