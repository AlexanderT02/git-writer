import chalk from "chalk";
import { editor, input, select, Separator } from "@inquirer/prompts";
import type { UiAction } from "./types.js";

export class UI {
  static render(msg: string): void {
    console.clear();

    const border = chalk.dim("─".repeat(60));
    console.log("\n" + border);
    console.log(chalk.bold("  Generated Commit"));
    console.log(border + "\n");
    console.log(msg || chalk.dim("...generating"));
    console.log("\n" + border);
  }

  static async actionMenu(): Promise<UiAction> {
    return select<UiAction>({
      message: "What do you want to do?",
      choices: [
        { name: " Commit", value: "commit" },
        { name: " Edit message manually", value: "edit" },
        { name: " Regenerate", value: "regen" },
        { name: " Refine with instruction", value: "refine" },
        { name: " Copy to clipboard", value: "copy" },
        new Separator(),
        { name: "✖ Cancel", value: "cancel" },
      ],
    });
  }

  static async refineInput(): Promise<string> {
    const text = await input({
      message: "Refinement instruction",
      validate: (value) => (value.trim() ? true : "Enter something"),
    });

    return text.trim();
  }

  static async editMessage(initial: string): Promise<string> {
    const text = await editor({
      message: "Edit commit message",
      default: initial,
    });

    return text.trim();
  }
}