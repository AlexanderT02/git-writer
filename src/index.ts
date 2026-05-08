#!/usr/bin/env node
import { execFileSync } from "child_process";
import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";
import { App } from "./core/App.js";
import { GracefulExit } from "./errors.js";
import { StatsRenderer } from "./stats/StatsRenderer.js";

type StatsOptions = {
  reset?: boolean;
};

type CommitOptions = {
  fast?: boolean;
};

type PROptions = {
  base?: string;
};

function assertGitInstalled(): void {
  try {
    execFileSync("git", ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    throw new GracefulExit(1, "Git is not installed or not available in PATH.");
  }
}

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

function assertGitReady(): void {
  assertGitInstalled();
  assertInsideGitRepo();
}

function validateGitRef(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new InvalidArgumentError("Base branch cannot be empty.");
  }

  if (trimmed.startsWith("-")) {
    throw new InvalidArgumentError("Base branch must be a valid git ref.");
  }

  return trimmed;
}

async function runCommit(options: CommitOptions): Promise<void> {
  assertGitReady();

  const app = new App(Boolean(options.fast));
  await app.runCommitInteractive();
}

async function runPR(options: PROptions): Promise<void> {
  assertGitReady();

  const app = new App(false);
  await app.runPRInteractive(options.base);
}

function runStats(period: string | undefined, options: StatsOptions): void {
  assertGitReady();

  const renderer = new StatsRenderer();

  if (options.reset) {
    renderer.renderReset();
  }

  renderer.render(period);
}

function createProgram(): Command {
  const program = new Command();

  program
    .name("gw")
    .description("AI-assisted Git commit, PR and repository stats helper")
    .showHelpAfterError()
    .showSuggestionAfterError();

  program
    .command("commit")
    .alias("c")
    .description("Generate and create an AI-assisted commit")
    .option("-f, --fast", "Skip interactive refinement where possible")
    .action(async (options: CommitOptions) => {
      await runCommit(options);
    });

  program
    .command("pr")
    .aliases(["p", "pull-request"])
    .description("Generate an AI-assisted pull request description")
    .option(
      "-b, --base <branch>",
      "Base branch used to compare changes, e.g. origin/main",
      validateGitRef,
    )
    .action(async (options: PROptions) => {
      await runPR(options);
    });

  program
    .command("stats")
    .alias("s")
    .description("Show git-writer usage statistics")
    .argument("[period]", "Stats period, e.g. today, week, month or all")
    .option("--reset", "Reset stored statistics before rendering")
    .action((period: string | undefined, options: StatsOptions) => {
      runStats(period, options);
    });

  program
    .command("h", { hidden: true })
    .action(() => {
      program.outputHelp();
    });

  return program;
}

const program = createProgram();

program.parseAsync(process.argv).catch((error: unknown) => {
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
