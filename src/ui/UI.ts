import chalk from "chalk";
import { editor, input, select, Separator } from "@inquirer/prompts";
import type { AppConfig } from "../config/config.js";
import type { CommitStats, UiAction } from "../types/types.js";

export class UI {
  static render(msg: string, config: AppConfig): void {
    if (config.ui.clearScreen) {
      console.clear();
    }

    const border = chalk.dim("─".repeat(config.ui.borderWidth));

    console.log("\n" + border);
    console.log(chalk.bold(`  ${config.ui.generatedCommitTitle}`));
    console.log(border + "\n");
    console.log(msg || chalk.dim(config.ui.generatingPlaceholder));
    console.log("\n" + border);
  }

  static renderPRPreview(
    baseBranch: string,
    title: string,
    description: string,
  ): void {
    console.log("");
    console.log(chalk.bold.blue("Pull Request Preview"));
    console.log(chalk.dim("─".repeat(48)));
    console.log(`${chalk.green("Base:")} ${baseBranch}`);
    console.log(`${chalk.green("Title:")} ${title}`);
    console.log("");
    console.log(chalk.green("Description:"));
    console.log(description);
    console.log(chalk.dim("─".repeat(48)));
  }

  static renderCommitCreated(stats: CommitStats | null): void {
    if (!stats) {
      console.log(chalk.green("\n✔  Commit created\n"));
      return;
    }

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
  }

  static renderNothingToCommit(): void {
    console.log(chalk.gray("\n  Nothing to commit\n"));
  }

  static renderCopied(label = "Copied to clipboard"): void {
    console.log(chalk.gray(`\n✔ ${label}\n`));
  }

  static renderCancelled(): void {
    console.log(chalk.gray("\nCancelled\n"));
  }

  static async actionMenu(config: AppConfig): Promise<UiAction> {
    return select<UiAction>({
      message: config.ui.actionMenuMessage,
      choices: [
        { name: config.ui.actions.commit, value: "commit" },
        { name: config.ui.actions.edit, value: "edit" },
        { name: config.ui.actions.regenerate, value: "regen" },
        { name: config.ui.actions.refine, value: "refine" },
        { name: config.ui.actions.copy, value: "copy" },
        new Separator(),
        { name: config.ui.actions.cancel, value: "cancel" },
      ],
    });
  }

  static async prActionMenu(): Promise<"copy" | "create" | "cancel"> {
    return select<"copy" | "create" | "cancel">({
      message: "Choose an action for this PR:",
      choices: [
        { name: "Copy PR to clipboard", value: "copy" },
        { name: "Create PR via GitHub CLI", value: "create" },
        new Separator(),
        { name: "Cancel", value: "cancel" },
      ],
    });
  }

  static async refineInput(config: AppConfig): Promise<string> {
    const text = await input({
      message: config.ui.refineMessage,
      validate: (value) =>
        value.trim() ? true : config.ui.emptyInputMessage,
    });

    return text.trim();
  }

  static async editMessage(
    initial: string,
    config: AppConfig,
  ): Promise<string> {
    const text = await editor({
      message: config.ui.editMessage,
      default: initial,
    });

    return text.trim();
  }

  static async selectBranch(
    branches: string[],
    message: string,
  ): Promise<string> {
    return select<string>({
      message,
      choices: branches.map((branch) => ({
        name: branch,
        value: branch,
      })),
    });
  }

  static showHelp(): never {
    const command = chalk.cyan;
    const option = chalk.yellow;
    const dim = chalk.dim;

    console.log("");
    console.log(chalk.bold.blue("Git Writer") + dim(" (gw)"));
    console.log("");

    console.log(chalk.bold("Usage"));
    console.log(`  ${command("gw")} ${dim("<command>")} ${dim("[options]")}`);
    console.log("");

    console.log(chalk.bold("Commands"));
    console.log(`  ${command("commit")}, ${command("c")}              ${dim("Generate a commit message")}`);
    console.log(`  ${command("pr")}, ${command("p")}                  ${dim("Generate a PR title and body")}`);
    console.log("");

    console.log(chalk.bold("Options"));
    console.log(`  ${option("-f")}, ${option("--fast")}             ${dim("Skip interactive prompts")}`);
    console.log(`  ${option("-b")}, ${option("--base")} ${dim("<branch>")}   ${dim("Base branch for PR comparison")}`);
    console.log(`  ${option("-h")}, ${option("--help")}             ${dim("Show this help message")}`);
    console.log("");

    console.log(chalk.bold("Examples"));
    console.log(`  ${dim("$")} ${command("gw c")}`);
    console.log(`  ${dim("$")} ${command("gw commit --fast")}`);
    console.log(`  ${dim("$")} ${command("gw pr")}`);
    console.log(`  ${dim("$")} ${command("gw p -b origin/develop")}`);
    console.log("");

    process.exit(0);
  }
}
