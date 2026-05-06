import chalk from "chalk";
import inquirer from "inquirer";

export class StagingService {
  constructor(git) {
    this.git = git;
  }

  getStatusLabel(code) {
    switch (code) {
      case "M":
        return chalk.yellow("● modified  ");
      case "A":
        return chalk.green("● added     ");
      case "D":
        return chalk.red("● deleted   ");
      case "?":
        return chalk.gray("● untracked ");
      case "R":
        return chalk.cyan("● renamed   ");
      default:
        return chalk.dim(code.padEnd(10));
    }
  }

  parseStatusDetailed() {
    const status = this.git.getStatus();
    if (!status) return [];

    return status.split("\n").map((line) => {
      const xy = line.slice(0, 2);
      const rest = line.slice(2).trim();
      const file = rest.includes(" -> ")
        ? rest.split(" -> ").pop().trim()
        : rest;
      const code = xy[1] !== " " ? xy[1] : xy[0];
      return { file, code };
    });
  }

  printSummary(files, stagedExists) {
    const total = files.length;
    console.log(chalk.bold("\nStage changes\n"));
    if (stagedExists)
      console.log(chalk.gray("↳ Using existing staged changes possible"));
    console.log(
      chalk.dim(`Detected ${total} changed file${total !== 1 ? "s" : ""}\n`),
    );
  }

  buildChoices(files, stagedExists) {
    return [
      { name: chalk.cyan.bold("✔ Stage ALL changes"), value: "__ALL__" },
      ...(stagedExists
        ? [
            {
              name: chalk.gray("↳ Use already staged files"),
              value: "__SKIP__",
            },
          ]
        : []),
      new inquirer.Separator(chalk.dim("──────── Files ────────")),
      ...files.map((f) => ({
        name: `${this.getStatusLabel(f.code)} ${f.file}`,
        value: f.file,
        checked: f.code !== "?",
      })),
    ];
  }

  async ensureStaged() {
    const staged = this.git.getStagedFiles().trim();
    const files = this.parseStatusDetailed();

    if (!files.length && !staged) {
      console.log(chalk.gray("\n✔ Working tree clean\n"));
      process.exit(0);
    }

    this.printSummary(files, !!staged);

    const choices = this.buildChoices(files, !!staged);
    const { selected } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "selected",
        message: "Select files to stage",
        choices,
        pageSize: 15,
        loop: false,
      },
    ]);

    if (selected.includes("__SKIP__")) {
      console.log(chalk.green("\n✔ Using already staged files\n"));
      return;
    }

    if (selected.includes("__ALL__")) {
      this.git.add(files.map((f) => f.file));
      console.log(
        chalk.green(
          `\n✔ Staged all ${files.length} file${files.length !== 1 ? "s" : ""}\n`,
        ),
      );
      return;
    }

    if (!selected.length) {
      console.log(chalk.red("\n✖ Nothing staged — aborting\n"));
      process.exit(0);
    }

    this.git.add(selected);
    console.log(
      chalk.green(
        `\n✔ Staged ${selected.length} file${selected.length !== 1 ? "s" : ""}\n`,
      ),
    );
  }
}