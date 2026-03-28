#!/usr/bin/env node

import { execSync } from "child_process";
import readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.log("ERROR: OPENAI_API_KEY not set");
  process.exit(1);
}

function getGitContext() {
  const files = execSync("git diff --cached --name-only").toString();

  let diff = execSync("git diff --cached").toString();

  const MAX_LINES = 800;

  if (diff.split("\n").length > MAX_LINES) {
    console.log("⚠️ large diff, using summary mode\n");
    diff = execSync("git diff --cached --stat").toString();
  }

  return { files, diff };
}

async function ensureStaged() {
  const { files } = getGitContext();
  const hasStaged = !!files.trim();

  const status = execSync("git status --porcelain").toString().trim();

  if (!status && !hasStaged) {
    console.log("Working tree clean");
    process.exit(0);
  }

  const changedFiles = status
    .split("\n")
    .map(line => line.slice(2).trim())
    .filter(Boolean);

  console.log("\nSelect files:\n");

  if (changedFiles.length > 0) {
    changedFiles.forEach((file, i) => {
      console.log(`[${i + 1}] ${file}`);
    });
  } else {
    console.log("No unstaged files");
  }

  console.log("\n[a] all   [p] patch   [m] more   [c] continue   [q] cancel");

  return new Promise((resolve) => {
    rl.question("› ", (answer) => {
      const input = answer.trim();

      if (input === "q") {
        console.log("\nCancelled\n");
        process.exit(0);
      }

      if (input === "c") {
        if (!hasStaged) {
          console.log("Nothing staged yet\n");
          return resolve(false);
        }
        return resolve(true);
      }

      if (input === "a") {
        execSync("git add .", { stdio: "inherit" });
        console.log("\n✔ All files staged\n");
        return resolve(true);
      }

      if (input === "p") {
        execSync("git add -p", { stdio: "inherit" });
        return resolve(true);
      }

      // Zahlen-Auswahl
      const indexes = input
        .split(",")
        .map(n => parseInt(n.trim(), 10) - 1)
        .filter(i => i >= 0 && i < changedFiles.length);

      if (indexes.length === 0) {
        console.log("Invalid selection\n");
        return resolve(false);
      }

      const selectedFiles = indexes.map(i => changedFiles[i]);

      try {
        execSync("git add -- " + selectedFiles.join(" "), {
          stdio: "inherit"
        });
      } catch {
        console.log("\nFailed to add files\n");
        return resolve(false);
      }

      console.log("\n✔ Files added\n");

      resolve(true);
    });
  });
}

const cliIssues = process.argv.slice(2)
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

let extraInstruction = "";

async function generate(safeFiles, safeStat) {
  const basePrompt = `
Write a realistic git commit message like a senior developer.

IMPORTANT:
- Avoid generic phrases like "improve", "enhance", "update"
- Be specific and concrete
- Slightly informal is OK
- Focus on WHAT actually changed

Rules:
- Use conventional commits
- Short summary (max 72 chars)
- Scope should match feature/domain

Style:
- Natural developer tone
- No marketing language
- No fluff

Format:

type(scope): summary

- concrete change
- concrete impact

Context:

Files:
${safeFiles}

Diff:
${safeStat}
`;

  const finalPrompt =
    basePrompt +
    (extraInstruction ? `\n\nRefine:\n${extraInstruction}` : "");

  process.stdout.write("\nGenerating commit...\n");

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
    const text = await res.text();
    console.error("\nAPI ERROR:\n", text);
    process.exit(1);
  }

  const json = await res.json();

  const msg = json.output?.[0]?.content?.[0]?.text;

  if (!msg) {
    console.error("Invalid API response");
    process.exit(1);
  }

  const cleaned = msg
  .replace(/```[a-z]*\n?/gi, "")   
  .replace(/```/g, "")         
  .replace(/^(git|plaintext|text)\s*/i, "") 
  .replace(/^\s*\n/, "")
  .trim();

  return cleaned;
}

function render(msg) {
  console.clear();

  console.log("────────────────────────────────────────────");
  console.log("COMMIT MESSAGE");
  console.log("────────────────────────────────────────────\n");

  console.log(msg);

  console.log("\n────────────────────────────────────────────");
  console.log("[Enter/y] commit   [r] regenerate   [r:<text>] refine   [n] cancel");
  console.log("────────────────────────────────────────────\n");
}

async function loop() {
  const ok = await ensureStaged();

  if (!ok) {
    return loop();
  }

  const { files, diff } = getGitContext();

  const safeFiles = files.replace(/[^\x00-\x7F]/g, "");
  const safeStat = diff.replace(/[^\x00-\x7F]/g, "");

  const msgBase = await generate(safeFiles, safeStat);

  const refs = issues.length > 0 ? `\n\nRefs ${issues.join(", ")}` : "";
  const msg = msgBase + refs;

  render(msg);

  rl.question("› ", (answer) => {
    const input = answer.trim();

    if (input === "" || input === "y") {
      execSync("git commit -F -", {
        input: msg,
        stdio: ["pipe", "inherit", "inherit"]
      });

      console.log("\n✔ Committed\n");
      rl.close();
    }

    else if (input.startsWith("r:")) {
      extraInstruction = input.slice(2).trim();
      loop();
    }

    else if (input === "r") {
      extraInstruction = "";
      loop();
    }

    else {
      console.log("\nCancelled\n");
      rl.close();
    }
  });
}

loop();