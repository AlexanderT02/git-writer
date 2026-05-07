#!/usr/bin/env node
import chalk from "chalk";
import { App } from "./core/App.js";

const args = process.argv.slice(2);
const fastMode = args.includes("-f") || args.includes("--fast");

const command = args[0];

function getOptionValue(name: string): string | null {
  const index = args.findIndex((arg) => arg === name);

  if (index === -1) return null;

  const value = args[index + 1];

  if (!value || value.startsWith("-")) {
    return null;
  }

  return value;
}

function showHelp() {
  console.log(chalk.blue("\nGit Commit Writer (gcw) CLI\n"));
  console.log("Usage:");
  console.log("  gcw <command> [options]\n");
  console.log("Commands:");
  console.log("  commit           Generate a commit message for staged changes");
  console.log("  pr               Generate a PR title and description for the current branch\n");
  console.log("Options:");
  console.log("  -f, --fast       Skip prompts and generate automatically");
  console.log("  --base <branch>  Base branch for PR comparison");
  console.log("  -h, --help       Show this help message\n");
  console.log("Examples:");
  console.log("  gcw commit");
  console.log("  gcw pr");
  console.log("  gcw pr --base origin/main");
  console.log("  gcw pr --base develop");
  console.log("  gcw pr -f\n");
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  showHelp();
}

(async () => {
  try {
    const app = new App(fastMode);

    switch (command) {
      case "commit": {
        await app.run();
        break;
      }

      case "pr": {
        const baseBranch = getOptionValue("--base");

        await app.runPRInteractive(baseBranch ?? undefined);
        break;
      }

      default: {
        console.log(chalk.yellow("\n⚠ No valid command provided."));
        showHelp();
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`\n✖ ${message}\n`));
    process.exit(1);
  }
})();
