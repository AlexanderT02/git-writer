import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { GracefulExit } from "../src/errors.js";

const mockLLM = {
  complete: vi.fn(async () => ({
    text: [
      "TYPE: feat",
      "SCOPE: auth",
      "INTENT: add login support",
      "WHY: NONE",
      "RISK: low",
      "BULLETS:",
      "- add login function",
      "- expose authentication entry point",
    ].join("\n"),
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    },
  })),

  stream: vi.fn(async (_prompt: string, onText?: (text: string) => void) => {
    const text = [
      "feat(auth): add login support",
      "",
      "- Add login function",
      "- Expose authentication entry point",
    ].join("\n");

    onText?.(text);

    return {
      text,
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        totalTokens: 160,
      },
    };
  }),
};

vi.mock("../src/llm/Factory.js", () => ({
  createLLMProvider: vi.fn(() => mockLLM),
}));

describe("Commit flow integration", () => {
  let cwd: string;
  let repo: string;

  beforeEach(() => {
    cwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), "git-writer-"));

    process.chdir(repo);

    git("init");
    git("config", "user.name", "Test User");
    git("config", "user.email", "test@example.com");

    writeFileSync("README.md", "# Test\n");
    git("add", "README.md");
    git("commit", "-m", "chore: initial commit");

    mockLLM.complete.mockClear();
    mockLLM.stream.mockClear();

    mockLLM.complete.mockResolvedValue({
      text: [
        "TYPE: feat",
        "SCOPE: auth",
        "INTENT: add login support",
        "WHY: NONE",
        "RISK: low",
        "BULLETS:",
        "- add login function",
        "- expose authentication entry point",
      ].join("\n"),
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    });

    mockLLM.stream.mockImplementation(
      async (_prompt: string, onText?: (text: string) => void) => {
        const text = [
          "feat(auth): add login support",
          "",
          "- Add login function",
          "- Expose authentication entry point",
        ].join("\n");

        onText?.(text);

        return {
          text,
          usage: {
            inputTokens: 120,
            outputTokens: 40,
            totalTokens: 160,
          },
        };
      },
    );
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it("exits successfully without calling the LLM when there is nothing to commit", async () => {
    const { App } = await import("../src/core/App.js");

    const before = commitCount();

    const app = new App(true, [], "openai");

    await expect(app.runCommitInteractive()).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(commitCount()).toBe(before);
    expect(mockLLM.complete).not.toHaveBeenCalled();
    expect(mockLLM.stream).not.toHaveBeenCalled();

    expect(git("status", "--porcelain")).toBe("");
  });

  it("appends configured issue refs to the real git commit message", async () => {
    const { App } = await import("../src/core/App.js");

    writeFileSync("auth.ts", "export function login() { return true; }\n");

    const app = new App(true, ["#123", "PROJ-9"], "openai");

    await expect(app.runCommitInteractive()).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    const fullMessage = git("log", "-1", "--pretty=%B");

    expect(fullMessage).toContain("feat(auth): add login support");
    expect(fullMessage).toContain("- Add login function");
    expect(fullMessage).toContain("refs #123, PROJ-9");
  });

  it("does not create a commit when the LLM reasoning call fails", async () => {
    const { App } = await import("../src/core/App.js");

    writeFileSync("auth.ts", "export function login() { return true; }\n");

    mockLLM.complete.mockRejectedValueOnce(new Error("LLM down"));

    const before = commitCount();

    const app = new App(true, [], "openai");

    await expect(app.runCommitInteractive()).rejects.toThrow("LLM down");

    expect(commitCount()).toBe(before);
    expect(mockLLM.complete).toHaveBeenCalledTimes(1);
    expect(mockLLM.stream).not.toHaveBeenCalled();

    const status = git("status", "--porcelain");

    expect(status).toContain("A  auth.ts");
  });

  it("does not create a commit when the LLM generation call fails", async () => {
    const { App } = await import("../src/core/App.js");

    writeFileSync("auth.ts", "export function login() { return true; }\n");

    mockLLM.stream.mockRejectedValueOnce(new Error("generation failed"));

    const before = commitCount();

    const app = new App(true, [], "openai");

    await expect(app.runCommitInteractive()).rejects.toThrow(
      "generation failed",
    );

    expect(commitCount()).toBe(before);
    expect(mockLLM.complete).toHaveBeenCalledTimes(1);
    expect(mockLLM.stream).toHaveBeenCalledTimes(1);

    const status = git("status", "--porcelain");

    expect(status).toContain("A  auth.ts");
  });

  it("records usage stats after a successful commit", async () => {
    const { App } = await import("../src/core/App.js");

    writeFileSync("auth.ts", "export function login() { return true; }\n");

    const app = new App(true, [], "openai");

    await expect(app.runCommitInteractive()).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    const usagePath = join(repo, ".git", "git-writer", "usage.jsonl");

    expect(existsSync(usagePath)).toBe(true);

    const lines = readFileSync(usagePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);

    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);

    expect(entry.command).toBe("commit");
    expect(entry.provider).toBe("openai");
    expect(entry.success).toBe(true);
    expect(entry.fastMode).toBe(true);
    expect(entry.usedTokens).toBe(310);
    expect(entry.inputTokens).toBe(220);
    expect(entry.outputTokens).toBe(90);
    expect(entry.fileCount).toBe(1);
    expect(entry.branch).toBe(git("rev-parse", "--abbrev-ref", "HEAD"));
  });
});

function git(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitCount(): number {
  return Number(git("rev-list", "--count", "HEAD"));
}