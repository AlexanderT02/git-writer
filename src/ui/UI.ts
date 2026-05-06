import chalk from "chalk";
import { editor, input, select, Separator } from "@inquirer/prompts";
import type { AppConfig } from "../config/config.js";
import type { UiAction } from "../types/types.js";

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
}
