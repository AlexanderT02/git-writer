#!/usr/bin/env node

import fetch from "node-fetch";
import { execSync } from "child_process";
import readline from "readline";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.log("ERROR: OPENAI_API_KEY not set");
  process.exit(1);
}


const files = execSync("git diff --cached --name-only").toString();
const MAX_LINES = 800;

let diff = execSync("git diff --cached").toString();

const lines = diff.split("\n");

if (lines.length > MAX_LINES) {
  console.log("⚠️ large diff, using summary mode\n");

  diff = execSync("git diff --cached --stat").toString();
}

if (!files.trim()) {
  console.log("No staged changes");
  process.exit(0);
}


const safeFiles = files.replace(/[^\x00-\x7F]/g, "");
const safeStat = diff.replace(/[^\x00-\x7F]/g, "");


let issue = "";
try {
  const branch = execSync("git rev-parse --abbrev-ref HEAD").toString();
  const match = branch.match(/\d+/);
  if (match) issue = `#${match[0]}`;
} catch {}


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

let extraInstruction = "";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});


async function generate() {
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

  return msg.replace(/```/g, "").trim();
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
  const msgBase = await generate();
  const msg = issue ? `${msgBase}\n\nRefs ${issue}` : msgBase;

  render(msg);

  rl.question("› ", (answer) => {
    const input = answer.trim();

    // default = commit
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