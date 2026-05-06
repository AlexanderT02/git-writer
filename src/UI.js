import chalk from "chalk";
import inquirer from "inquirer";

export class UI {
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
          { name: "✖ Cancel", value: "cancel" },
        ],
      },
    ]);
    return action;
  }

  static async refineInput() {
    const { text } = await inquirer.prompt([
      {
        type: "input",
        name: "text",
        message: "Refinement instruction",
        validate: (v) => (v.trim() ? true : "Enter something"),
      },
    ]);
    return text.trim();
  }

  static async editMessage(initial) {
    const { text } = await inquirer.prompt([
      {
        type: "editor",
        name: "text",
        message: "Edit commit message",
        default: initial,
      },
    ]);
    return text.trim();
  }
}