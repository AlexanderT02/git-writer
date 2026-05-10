import chalk from "chalk";
import { editor, input, select, Separator } from "@inquirer/prompts";
import type { AppConfig } from "../config/config.js";
import { marked } from "marked";
import readline from "node:readline";
import TerminalRenderer from "marked-terminal";
import type {
  BranchPRSummary,
  CommitStats,
  StatusEntry,
  UiAction,
} from "../types/types.js";
import { formatStatusSummary } from "../staging/treePrompt.js";
marked.setOptions({
  renderer: new TerminalRenderer(),
});

export class UI {
  static createCommitMessageLiveRenderer(config: AppConfig): {
    render: (message: string) => void;
    end: (message?: string) => void;
  } {
    const border = chalk.dim("─".repeat(config.ui.borderWidth));

    let started = false;
    let renderedLines = 0;
    let lastMessage = "";
    let ended = false;

    const visibleLineCount = (text: string): number => {
      return Math.max(1, text.split("\n").length);
    };

    const buildFrame = (message: string): string => {
      const body = message.trim() || chalk.dim(config.ui.generatingPlaceholder);

      return [
        "",
        border,
        chalk.bold(`  ${config.ui.generatedCommitTitle}`),
        border,
        "",
        body,
        "",
        border,
      ].join("\n");
    };

    const frameLineCount = (message: string): number => {
      const body = message.trim() || config.ui.generatingPlaceholder;

      // buildFrame has:
      // 1 leading empty line
      // 1 top border
      // 1 title
      // 1 title border
      // 1 empty line
      // N body lines
      // 1 empty line
      // 1 bottom border
      return 7 + visibleLineCount(body);
    };

    const clearPreviousFrame = (): void => {
      if (!started || renderedLines <= 0) return;

      readline.moveCursor(process.stdout, 0, -renderedLines);
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);
    };

    const draw = (message: string): void => {
      const normalized = message.trim();

      if (!normalized) return;
      if (normalized === lastMessage) return;

      clearPreviousFrame();

      process.stdout.write(buildFrame(normalized) + "\n");

      renderedLines = frameLineCount(normalized);
      lastMessage = normalized;
      started = true;
    };

    return {
      render(message: string): void {
        if (ended) return;
        draw(message);
      },

      end(message?: string): void {
        if (ended) return;

        const finalMessage = (message ?? lastMessage).trim();

        if (finalMessage && finalMessage !== lastMessage) {
          draw(finalMessage);
        }

        if (!started) {
          process.stdout.write(buildFrame("") + "\n");
          renderedLines = frameLineCount("");
          started = true;
        }

        ended = true;
      },
    };
  }

  static renderCommitMessage(msg: string, config: AppConfig): void {
    const renderer = UI.createCommitMessageLiveRenderer(config);
    renderer.end(msg);
  }

  static renderPRPreview(
    baseBranch: string,
    title: string,
    description: string,
  ): void {
    const border = chalk.dim("─".repeat(72));

    console.log("");
    console.log(border);
    console.log(chalk.bold.blue("Pull Request Preview"));
    console.log(border);

    console.log(`${chalk.dim("Base ")}  ${chalk.cyan(baseBranch)}`);
    console.log(`${chalk.dim("Title")}  ${chalk.green(title)}`);

    console.log("");
    console.log(chalk.dim("Body"));
    console.log(chalk.dim("────"));

    console.log(marked(description));

    console.log(border);
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

  static async commitActionMenu(config: AppConfig): Promise<UiAction> {
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
    branches: BranchPRSummary[],
    message: string,
  ): Promise<string> {
    return select<string>({
      message,
      choices: branches.map((branch) => ({
        name:
          `${branch.branch} ` +
          chalk.dim(
            `(${branch.commits} commit${branch.commits !== 1 ? "s" : ""}, ` +
            `${branch.files} file${branch.files !== 1 ? "s" : ""}, ` +
            chalk.green(`+${branch.insertions}`) +
            " " +
            chalk.red(`-${branch.deletions}`) +
            ")",
          ),
        value: branch.branch,
      })),
    });
  }

  static renderPRCreated(url: string): void {
    console.log(chalk.green("\n✔ Pull request created\n"));

    if (url) {
      console.log(chalk.cyan(url));
      console.log("");
    }
  }

  static renderStagingSummary(
    files: StatusEntry[],
    stagedExists: boolean,
  ): void {
    const total = files.length;

    console.log("");
    console.log(
      chalk.bold("  Stage changes") +
        chalk.dim(`  ${total} file${total !== 1 ? "s" : ""} `) +
        formatStatusSummary(files),
    );

    if (stagedExists) {
      console.log(chalk.dim.italic("  ↳ staged changes already present"));
    }

    console.log("");
  }

  static renderWorkingTreeClean(): void {
    console.log(chalk.gray("\n  ✔ Working tree clean\n"));
  }

  static renderUsingAlreadyStagedFiles(): void {
    console.log(chalk.green("\n  ✔ Using already staged files\n"));
  }

  static renderStagedAllFiles(fileCount: number): void {
    console.log(
      chalk.green(
        `\n  ✔ Staged all ${fileCount} file${fileCount !== 1 ? "s" : ""}\n`,
      ),
    );
  }

  static renderStagedSelectedFiles(fileCount: number): void {
    console.log(
      chalk.green(
        `\n  ✔ Staged ${fileCount} file${fileCount !== 1 ? "s" : ""}\n`,
      ),
    );
  }

  static renderNothingSelected(): void {
    console.log(chalk.red("\n  ✖ Nothing selected — aborting\n"));
  }

  static renderPartiallyStagedSelectionWarning(files: string[]): void {
    console.log("");
    console.log(chalk.yellow.bold("  ⚠ Partially staged files selected"));
    console.log(
      chalk.dim(
        "  These files already have staged changes and also contain unstaged changes.",
      ),
    );
    console.log(
      chalk.dim(
        "  Staging them now will include the remaining unstaged changes too.",
      ),
    );
    console.log("");

    for (const file of files.slice(0, 10)) {
      console.log(`  ${chalk.yellow("•")} ${file}`);
    }

    if (files.length > 10) {
      console.log(chalk.dim(`  … ${files.length - 10} more`));
    }

    console.log("");
  }

  static renderPullRequestAlreadyExists(): void {
    console.log("\n  ✔ Pull request already exists.\n");
  }

  static renderNoPRChanges(baseBranch: string): void {
    console.log(`\n  ✖ No PR changes found against ${baseBranch}.\n`);
  }

  static renderPRFailure(result: {
    message: string;
    suggestedCommand?: string;
  }): void {
    console.log(`\n  ✖ ${result.message}`);

    if (result.suggestedCommand) {
      console.log(`  → ${result.suggestedCommand}`);
    }

    console.log("");
  }

  static async unpushedCommitsWarningMenu(input: {
    hasUpstream: boolean;
    branch: string;
    upstream?: string;
    count: number;
    suggestedCommand?: string;
  }): Promise<"push" | "continue" | "cancel"> {
    console.log("");
    console.log(chalk.yellow.bold("  ⚠ Unpushed commits detected"));
    console.log("");

    if (input.hasUpstream) {
      console.log(
        chalk.dim(
          `  Current branch ${input.branch} has ${input.count} unpushed commit${
            input.count !== 1 ? "s" : ""
          } ahead of ${input.upstream}.`,
        ),
      );
    } else {
      console.log(
        chalk.dim(
          `  Current branch ${input.branch} has no upstream branch configured.`,
        ),
      );
    }

    if (input.suggestedCommand) {
      console.log(chalk.dim(`  Suggested: ${input.suggestedCommand}`));
    }

    console.log("");

    return select({
      message: "How do you want to continue?",
      choices: [
        {
          name: input.hasUpstream ? "Push now" : "Push and set upstream",
          value: "push",
        },
        {
          name: "Continue to preview without pushing",
          value: "continue",
        },
        {
          name: "Cancel",
          value: "cancel",
        },
      ],
    });
  }
}
