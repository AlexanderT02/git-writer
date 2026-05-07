#!/usr/bin/env node
import chalk from "chalk";
import { App } from "./core/App.js";

const args = process.argv.slice(2);

const hasFlag = (...flags: string[]): boolean =>
  args.some((arg) => flags.includes(arg));

const getOptionValue = (...names: string[]): string | undefined => {
  const index = args.findIndex((arg) => names.includes(arg));
  const value = index >= 0 ? args[index + 1] : undefined;

  return value && !value.startsWith("-") ? value : undefined;
};

const showHelp = (): never => {
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
    showHelp();
  }

  const command = normalizeCommand(args[0]);
  const app = new App(hasFlag("-f", "--fast"));

  if (command === "commit") {
    await app.run();
    return;
  }

  if (command === "pr") {
    await app.runPRInteractive(getOptionValue("-b", "--base"));
    return;
  }

  console.log(chalk.yellow("\n⚠ No valid command provided."));
  showHelp();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(`\n✖ ${message}\n`));
  process.exit(1);
});