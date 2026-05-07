#!/usr/bin/env node
import { execFileSync } from "child_process";
import chalk from "chalk";
import { App } from "./core/App.js";
import { UI } from "./ui/UI.js";
import { GracefulExit } from "./errors.js";

const args = process.argv.slice(2);

const KNOWN_FLAGS = new Set(["-h", "--help", "-f", "--fast", "-b", "--base"]);

const hasFlag = (...flags: string[]): boolean =>
  args.some((arg) => flags.includes(arg));

const getOptionValue = (...names: string[]): string | undefined => {
  const index = args.findIndex((arg) => names.includes(arg));

  if (index < 0) return undefined;

  const value = args[index + 1];

  if (!value || value.startsWith("-")) {
    console.warn(
      chalk.yellow(`\n⚠ ${args[index]} requires a value (e.g. origin/main)\n`),
    );
    return undefined;
  }

  return value;
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

function assertInsideGitRepo(): void {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    throw new GracefulExit(
      1,
      "Not a git repository. Run this from inside a git project.",
    );
  }
}

function assertGitInstalled(): void {
  try {
    execFileSync("git", ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    throw new GracefulExit(
      1,
      "Git is not installed or not available in PATH.",
    );
  }
}

function warnUnknownFlags(): void {
  for (const arg of args) {
    if (arg.startsWith("-") && !KNOWN_FLAGS.has(arg)) {
      console.warn(chalk.yellow(`⚠ Unknown flag: ${arg}`));
    }
  }
}

function validateFlagCombinations(): void {
  if (hasFlag("-f", "--fast") && normalizeCommand(args[0]) === "pr") {
    console.warn(
      chalk.yellow("⚠ --fast is only supported with the commit command\n"),
    );
  }

  if (hasFlag("-b", "--base") && normalizeCommand(args[0]) === "commit") {
    console.warn(
      chalk.yellow("⚠ --base is only supported with the pr command\n"),
    );
  }
}

async function main(): Promise<void> {
  if (hasFlag("-h", "--help")) {
    UI.showHelp();
    return;
  }

  const command = normalizeCommand(args[0]);

  if (command === "help") {
    console.log(chalk.yellow("\n⚠ No valid command provided."));
    UI.showHelp();
    return;
  }

  warnUnknownFlags();
  validateFlagCombinations();
  assertGitInstalled();
  assertInsideGitRepo();

  const app = new App(hasFlag("-f", "--fast"));

  if (command === "commit") {
    await app.runCommitInteractive();
    return;
  }

  if (command === "pr") {
    await app.runPRInteractive(getOptionValue("-b", "--base"));
    return;
  }
}

main().catch((error: unknown) => {
  if (error instanceof GracefulExit) {
    if (error.code !== 0 && error.message) {
      console.error(chalk.red(`\n✖ ${error.message}\n`));
    }

    process.exit(error.code);
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(`\n✖ ${message}\n`));
  process.exit(1);
});
