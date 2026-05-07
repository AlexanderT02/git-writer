#!/usr/bin/env node
import chalk from "chalk";
import { App } from "./core/App.js";
import { UI } from "./ui/UI.js";

const args = process.argv.slice(2);

const hasFlag = (...flags: string[]): boolean =>
  args.some((arg) => flags.includes(arg));

const getOptionValue = (...names: string[]): string | undefined => {
  const index = args.findIndex((arg) => names.includes(arg));
  const value = index >= 0 ? args[index + 1] : undefined;

  return value && !value.startsWith("-") ? value : undefined;
};

const normalizeCommand = (command?: string): "commit" | "pr" | "help" => {
  switch (command) {
    case "commit":
    case "c":
      return "commit";

    case "pr":
    case "p":
    case "pull-request":
      return "pr";

    default:
      return "help";
  }
};

async function main(): Promise<void> {
  if (hasFlag("-h", "--help")) {
    UI.showHelp();
  }

  const command = normalizeCommand(args[0]);
  const app = new App(hasFlag("-f", "--fast"));

  if (command === "commit") {
    await app.runCommitInteractive();
    return;
  }

  if (command === "pr") {
    await app.runPRInteractive(getOptionValue("-b", "--base"));
    return;
  }

  console.log(chalk.yellow("\n⚠ No valid command provided."));
  UI.showHelp();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(`\n✖ ${message}\n`));
  process.exit(1);
});
