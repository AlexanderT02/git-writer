#!/usr/bin/env node
import { execSync, spawnSync } from "child_process";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import fetch from "node-fetch";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.log(chalk.red.bold("\n✖ OPENAI_API_KEY not set\n"));
  process.exit(1);
}


function getGitContext() {
  const files = execSync("git diff --cached --name-only").toString();
  let diff = execSync("git diff --cached").toString();

  if (diff.split("\n").length > 800) {
    console.log(chalk.yellow("⚠  Large diff — using summary mode\n"));
    diff = execSync("git diff --cached --stat").toString();
  }

  return { files, diff };
}


const cliIssues = process.argv
  .slice(2)
  .flatMap(a => a.split(","))
  .map(a => a.trim().match(/^#?(\d+)$/)?.[1])
  .filter(Boolean)
  .map(n => `#${n}`);

let issues = cliIssues;

if (issues.length === 0) {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD").toString();
    const match = branch.match(/\d+/);
    if (match) issues = [`#${match[0]}`];
  } catch {}
}


async function ensureStaged() {
  const { files } = getGitContext();
  const hasStaged = !!files.trim();

  const status = execSync("git status --porcelain").toString().trim();

  if (!status && !hasStaged) {
    console.log(chalk.gray("\nWorking tree clean\n"));
    process.exit(0);
  }

  const changedFiles = status
    .split("\n")
    .filter(Boolean)
    .map(line => {
      const xy = line.slice(0, 2);
      const rest = line.slice(2).trimStart();
      const file = rest.includes(" -> ") ? rest.split(" -> ").pop().trim() : rest;
      const status = xy[1] !== " " ? xy[1] : xy[0];
      return { status, file };
    });

  const statusLabel = s => {
    if (s === "M") return chalk.yellow("modified ");
    if (s === "A") return chalk.green("new file ");
    if (s === "D") return chalk.red("deleted  ");
    if (s === "?") return chalk.gray("untracked");
    return chalk.gray(s.padEnd(9));
  };

  const choices = [
    ...(hasStaged
      ? [{name: chalk.gray("   → Use already staged files"), value: "__SKIP__"}]
      : []),
    ...changedFiles.map(({ status, file }) => ({
      name: `  ${statusLabel(status).padEnd(12)} ${file}`,
      value: file
    }))
  ];

  if (choices.length === 0) {
    if (hasStaged) return true;
    console.log(chalk.gray("  Nothing to stage\n"));
    return false;
  }

  console.log(chalk.bold("\n  Stage files\n"));

  const { selected } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "selected",
      message: "Pick files to stage",
      choices,
      pageSize: 12
    }
  ]);

  if (selected.includes("__SKIP__")) return true;

  if (selected.length === 0) {
    if (hasStaged) return true;
    console.log(chalk.red("\n  Nothing staged — aborting\n"));
    process.exit(0);
  }

  spawnSync("git", ["add", "--", ...selected], {
    stdio: "inherit"
  });

  console.log(
    chalk.green(`\n  ✔ ${selected.length} file${selected.length > 1 ? "s" : ""} staged\n`)
  );

  return true;
}


let extraInstruction = "";

async function generate(safeFiles, safeStat) {
  const basePrompt = `
Write EXACTLY ONE git commit message.

IMPORTANT:
- Only ONE commit
- No multiple commits

Format:

type(scope): summary

- change
- impact

Files:
${safeFiles}

Diff:
${safeStat}
`;

  const finalPrompt =
    basePrompt + (extraInstruction ? `\n\nRefine:\n${extraInstruction}` : "");

  const spinner = ora({
    text: chalk.gray("Generating commit message…"),
    color: "cyan"
  }).start();

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: finalPrompt
    })
  });

  if (!res.ok) {
    spinner.fail(chalk.red("API request failed"));
    console.error(chalk.red(await res.text()));
    process.exit(1);
  }

  const json = await res.json();
  const msg = json.output?.[0]?.content?.[0]?.text;

  spinner.succeed(chalk.green("Done"));

  return msg
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "")
    .trim();
}


function render(msg) {
  console.clear();

  const border = chalk.dim("─".repeat(50));
  console.log("\n" + border);
  console.log(chalk.bold.white("  COMMIT MESSAGE"));
  console.log(border + "\n");

  console.log("  " + msg);

  console.log("\n" + border);
  console.log("  [Enter] commit   [r] regenerate   [r:<text>] refine   [n] cancel");
  console.log(border + "\n");
}

async function loop() {
  while (true) {
    await ensureStaged();

    const { files, diff } = getGitContext();

    const msgBase = await generate(files, diff);
    const refs = issues.length ? `\n\nRefs ${issues.join(", ")}` : "";
    const msg = msgBase + refs;

    render(msg);

    const { input } = await inquirer.prompt([
      {
        type: "input",
        name: "input",
        message: "›"
      }
    ]);

    const value = input.trim();

    if (value === "" || value === "y") {
      execSync("git commit -F -", {
        input: msg,
        stdio: ["pipe", "inherit", "inherit"]
      });

      console.log(chalk.green.bold("\n✔ Committed\n"));
      process.exit(0);
    }

    if (value.startsWith("r:")) {
      extraInstruction = value.slice(2).trim();
      continue;
    }

    if (value === "r") {
      extraInstruction = "";
      continue;
    }

    console.log(chalk.gray("\nCancelled\n"));
    process.exit(0);
  }
}

loop();
