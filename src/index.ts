#!/usr/bin/env node

import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";
import { config } from "./config/config.js";
import { App } from "./core/App.js";
import { GracefulExit } from "./errors.js";
import { StatsRenderer } from "./stats/StatsRenderer.js";
import { ProviderSettings } from "./llm/ProviderSettings.js";
import type { LLMProviderName } from "./config/config.js";
import { realpathSync } from "fs";

type StatsOptions = {
  reset?: boolean;
};

type CommitOptions = {
  force?: boolean;
};

type PROptions = {
  base?: string;
  auto?: boolean;
  force?: boolean;
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

function validateProvider(value: string): LLMProviderName {
  const settings = new ProviderSettings();
  const trimmed = value.trim();

  if (!settings.isProviderName(trimmed)) {
    throw new InvalidArgumentError(
      `Invalid provider "${value}". Expected one of: ${settings
        .availableProviders()
        .join(", ")}`,
    );
  }

  return trimmed;
}

function normalizeIssues(issues: string[]): string[] {
  return issues
    .map((issue) => issue.trim())
    .filter(Boolean);
}

async function runCommit(
  issues: string[],
  options: CommitOptions,
): Promise<void> {
  assertGitReady();

  const provider = new ProviderSettings().getCurrentProvider();
  const app = new App(Boolean(options.force), normalizeIssues(issues), provider);

  await app.runCommitInteractive();
}

async function runPR(options: PROptions): Promise<void> {
  assertGitReady();

  const provider = new ProviderSettings().getCurrentProvider();
  const isAuto = Boolean(options.auto) || Boolean(options.force);
  const isForce = Boolean(options.force);
  const app = new App(isAuto, [], provider, isForce);

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

export function createProgram(): Command {
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
    .argument("[issues...]", "Issue references, e.g. 123 456")
    .option(
      "-f, --force",
      "Skip the interactive menu and commit directly; large changes may be split into multiple logical commits",
    )
    .action(async (issues: string[], options: CommitOptions) => {
      await runCommit(issues, options);
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
    .option("-a, --auto", "Auto mode: commit, push, and create PR with confirmations")
    .option("-f, --force", "Force mode: commit, push, and create PR without confirmations")
    .action(async (options: PROptions) => {
      await runPR(options);
    });

  const providerCommand = program
    .command("provider")
    .description("Manage the active LLM provider");

  providerCommand
    .command("get")
    .description("Show the currently active LLM provider and models")
    .action(() => {
      const settings = new ProviderSettings();
      const provider = settings.getCurrentProvider();
      const providerConfig = config.llm.providers[provider];

      console.log("");
      console.log(`Active provider:   ${chalk.cyan(provider)}`);
      console.log(
        `Reasoning model:   ${chalk.cyan(providerConfig.reasoningModel)}`,
      );
      console.log(
        `Generation model:  ${chalk.cyan(providerConfig.generationModel)}`,
      );
      console.log("");
      console.log(
        chalk.gray(
          "Hint: To use different models, add a new provider profile in src/config/config.ts.",
        ),
      );
      console.log("");
    });

  providerCommand
    .command("set")
    .description("Set the active LLM provider")
    .argument(
      "<provider>",
      "Provider name, e.g. openai, ollama or gemini",
      validateProvider,
    )
    .action((provider: LLMProviderName) => {
      new ProviderSettings().setProvider(provider);

      console.log(chalk.green(`\n✔ Active provider set to ${provider}\n`));
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

function runCli(): void {
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
}

function isDirectRun(): boolean {
  const entry = process.argv[1];

  if (!entry) return false;

  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  runCli();
}
