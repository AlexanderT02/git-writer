#!/usr/bin/env node
import chalk from "chalk";

import { OpenAIClient } from "./src/OpenAIClient.js";
import { GitService } from "./src/GitService.js";
import { UI } from "./src/UI.js";
import { StagingService } from "./src/StagingService.js";
import { ContextBuilder } from "./src/ContextBuilder.js";
import { CommitGenerator } from "./src/CommitGenerator.js";

class App {
  constructor() {
    this.git = new GitService();
    this.ai = new OpenAIClient();
    this.staging = new StagingService(this.git);
    this.context = new ContextBuilder(this.git);
    this.generator = new CommitGenerator(this.ai);
    this.issueRefs = this.parseIssueRefs();
  }



  

  parseIssueRefs() {
    const args = process.argv.slice(2);
    const nums = args.filter((a) => /^\d+$/.test(a));
    if (!nums.length) return null;
    return nums.map((n) => `#${n}`);
  }

  appendIssueRefs(message) {
    if (!this.issueRefs) return message;
    return `${message}\n\nrefs ${this.issueRefs.join(", ")}`;
  }

  async run() {
    while (true) {
      await this.staging.ensureStaged();

      const files = this.git.getStagedFiles();
      const ctx = this.context.build(files);

      let message = await this.generator.generate(files, ctx);

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
          const text = await UI.refineInput();
          this.generator.extraInstruction = text;
          message = await this.generator.generate(files, ctx);
          continue;
        }

        if (action === "edit") {
          message = await UI.editMessage(message);
          continue;
        }

        if (action === "copy") {
          await import("clipboardy").then((m) => m.default.write(message));
          console.log(chalk.gray("\n✔ Copied to clipboard\n"));
          continue;
        }

        console.log(chalk.gray("\nCancelled\n"));
        process.exit(0);
      }
    }
  }
}

new App().run();