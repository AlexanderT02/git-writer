import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { GracefulExit } from "../src/errors.js";

const mockLLM = {
  complete: vi.fn(),
  stream: vi.fn(),
};

vi.mock("../src/llm/Factory.js", () => ({
  createLLMProvider: vi.fn(() => mockLLM),
}));

const mockCollectSummaries = vi.fn();
const mockGroupChanges = vi.fn();

vi.mock("../src/generation/ChangeGrouper.js", () => ({
  ChangeGrouper: vi.fn().mockImplementation(() => ({
    collectSummaries: mockCollectSummaries,
    group: mockGroupChanges,
  })),
}));

type TestGroup = {
  label: string;
  conventionalType: string;
  files: string[];
};

describe("Fast commit flow integration", () => {
  let cwd: string;
  let repo: string;

  beforeEach(() => {
    cwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), "git-writer-fast-"));

    process.chdir(repo);

    git("init");
    git("config", "user.name", "Test User");
    git("config", "user.email", "test@example.com");

    writeFileSync("README.md", "# Test\n");
    git("add", "README.md");
    git("commit", "-m", "chore: initial commit");

    vi.clearAllMocks();

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

  it("stages and commits deleted tracked files", async () => {
    const { App } = await import("../src/core/App.js");

    rmSync("README.md");

    mockLLM.stream.mockImplementationOnce(
      async (_prompt: string, onText?: (text: string) => void) => {
        const text = [
          "chore: remove README",
          "",
          "- Remove obsolete README file",
        ].join("\n");

        onText?.(text);

        return {
          text,
          usage: {
            inputTokens: 80,
            outputTokens: 20,
            totalTokens: 100,
          },
        };
      },
    );

    const before = commitCount();
    const app = new App(true, [], "openai");

    await expect(app.runCommitInteractive()).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(commitCount()).toBe(before + 1);
    expect(git("log", "-1", "--pretty=%s")).toBe("chore: remove README");
    expect(git("show", "--name-status", "--pretty=", "-1")).toContain(
      "D\tREADME.md",
    );
    expect(git("status", "--porcelain")).toBe("");
  });

  it("creates one commit per generated group and preserves grouped file ownership", async () => {
    const { App } = await import("../src/core/App.js");
    const { groups } = await prepareSplitScenario();

    mockLLM.stream
      .mockResolvedValueOnce(commitGenerationResult("feat(core): add core files"))
      .mockResolvedValueOnce(
        commitGenerationResult("chore(files): add supporting files"),
      );

    const before = commitCount();
    const app = new App(true, [], "openai");

    await expect(app.runCommitInteractive()).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockCollectSummaries).toHaveBeenCalledTimes(1);
    expect(mockGroupChanges).toHaveBeenCalledTimes(1);

    expect(mockLLM.complete).toHaveBeenCalledTimes(2);
    expect(mockLLM.stream).toHaveBeenCalledTimes(2);

    expect(commitCount()).toBe(before + 2);

    expect(lastSubjects(2)).toEqual([
      "chore(files): add supporting files",
      "feat(core): add core files",
    ]);

    expect(commitFiles("HEAD~1")).toEqual(groups[0]!.files);
    expect(commitFiles("HEAD")).toEqual(groups[1]!.files);

    expect(git("status", "--porcelain")).toBe("");
  });

  it("prints compact grouping, per-commit status, and final total stats in split mode", async () => {
    const { App } = await import("../src/core/App.js");
    const { splitThreshold } = await prepareSplitScenario();

    mockLLM.stream
      .mockResolvedValueOnce(commitGenerationResult("feat(core): add core files"))
      .mockResolvedValueOnce(
        commitGenerationResult("chore(files): add supporting files"),
      );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const app = new App(true, [], "openai");

      await expect(app.runCommitInteractive()).rejects.toMatchObject({
        code: 0,
      } satisfies Partial<GracefulExit>);

      const output = stripAnsi(
        logSpy.mock.calls
          .flat()
          .map(String)
          .join("\n"),
      );

      expect(output).toContain(`Grouping ${splitThreshold} changed files`);
      expect(output).toContain("2 groups");

      expect(output).toContain("1. feat: core files — 2 files");
      expect(output).toContain("2. chore: supporting files — 2 files");

      expect(output).toContain("Commit 1/2: feat(core): add core files");
      expect(output).toContain(
        "Commit 2/2: chore(files): add supporting files",
      );

      expect(output).toContain("Commit created");
      expect(output).toContain("Done — 2 commits created (4 files  +4  -0)");

      expect(output).not.toContain("file-0.ts added");
      expect(output).not.toContain("...and");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("skips empty groups without creating an extra commit", async () => {
    const { App } = await import("../src/core/App.js");
    const { splitThreshold } = await createChangedFiles();

    const firstGroupFiles = ["file-0.ts", "file-1.ts"];
    const missingGroupFiles = ["does-not-exist.ts"];

    mockCollectSummaries.mockReturnValue(
      Array.from({ length: splitThreshold }, (_, i) => ({
        file: `file-${i}.ts`,
        status: "A",
        additions: 1,
        deletions: 0,
        summary: `file-${i}.ts added`,
      })),
    );

    mockGroupChanges.mockResolvedValue({
      groups: [
        {
          label: "core files",
          conventionalType: "feat",
          files: firstGroupFiles,
        },
        {
          label: "missing files",
          conventionalType: "chore",
          files: missingGroupFiles,
        },
      ],
    });

    mockLLM.stream.mockResolvedValueOnce(
      commitGenerationResult("feat(core): add core files"),
    );

    const before = commitCount();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const app = new App(true, [], "openai");

      await expect(app.runCommitInteractive()).rejects.toMatchObject({
        code: 0,
      } satisfies Partial<GracefulExit>);

      const output = stripAnsi(
        logSpy.mock.calls
          .flat()
          .map(String)
          .join("\n"),
      );

      expect(commitCount()).toBe(before + 1);
      expect(mockLLM.complete).toHaveBeenCalledTimes(1);
      expect(mockLLM.stream).toHaveBeenCalledTimes(1);
      expect(output).toContain("Skipped missing files: no stageable files");
      expect(output).toContain("Done — 1 commit created");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("skips missing files inside a group and commits the remaining files", async () => {
    const { App } = await import("../src/core/App.js");
    const { splitThreshold } = await createChangedFiles();

    const validFiles = ["file-0.ts", "file-1.ts"];
    const missingFile = "does-not-exist.ts";

    mockCollectSummaries.mockReturnValue(
        Array.from({ length: splitThreshold }, (_, i) => ({
        file: `file-${i}.ts`,
        status: "A",
        additions: 1,
        deletions: 0,
        summary: `file-${i}.ts added`,
        })),
    );

    mockGroupChanges.mockResolvedValue({
        groups: [
        {
            label: "mixed files",
            conventionalType: "feat",
            files: [validFiles[0], missingFile, validFiles[1]],
        },
        ],
    });

    mockLLM.stream.mockResolvedValueOnce(
        commitGenerationResult("feat(files): add available files"),
    );

    const before = commitCount();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
        const app = new App(true, [], "openai");

        await expect(app.runCommitInteractive()).rejects.toMatchObject({
        code: 0,
        } satisfies Partial<GracefulExit>);

        const output = stripAnsi(
        logSpy.mock.calls
            .flat()
            .map(String)
            .join("\n"),
        );

        expect(commitCount()).toBe(before + 1);

        expect(mockLLM.complete).toHaveBeenCalledTimes(1);
        expect(mockLLM.stream).toHaveBeenCalledTimes(1);

        expect(git("log", "-1", "--pretty=%s")).toBe(
        "feat(files): add available files",
        );

        expect(commitFiles("HEAD")).toEqual(validFiles);

        expect(output).toContain("Skipped 1 file in mixed files: not stageable");
        expect(output).toContain("Done — 1 commit created");
        expect(output).toContain("(2 files  +2  -0)");

        expect(git("status", "--porcelain")).not.toContain(missingFile);
    } finally {
        logSpy.mockRestore();
    }
    });
});

async function prepareSplitScenario(): Promise<{
  splitThreshold: number;
  groups: TestGroup[];
}> {
  const { splitThreshold } = await createChangedFiles();

  const firstGroupFiles = Array.from(
    { length: Math.ceil(splitThreshold / 2) },
    (_, i) => `file-${i}.ts`,
  );

  const secondGroupFiles = Array.from(
    { length: splitThreshold - firstGroupFiles.length },
    (_, i) => `file-${i + firstGroupFiles.length}.ts`,
  );

  const groups: TestGroup[] = [
    {
      label: "core files",
      conventionalType: "feat",
      files: firstGroupFiles,
    },
    {
      label: "supporting files",
      conventionalType: "chore",
      files: secondGroupFiles,
    },
  ];

  mockCollectSummaries.mockReturnValue(
    Array.from({ length: splitThreshold }, (_, i) => ({
      file: `file-${i}.ts`,
      status: "A",
      additions: 1,
      deletions: 0,
      summary: `file-${i}.ts added`,
    })),
  );

  mockGroupChanges.mockResolvedValue({ groups });

  return {
    splitThreshold,
    groups,
  };
}

async function createChangedFiles(): Promise<{ splitThreshold: number }> {
  const { config } = await import("../src/config/config.js");
  const splitThreshold = config.grouping.splitThreshold;

  for (let i = 0; i < splitThreshold; i++) {
    writeFileSync(`file-${i}.ts`, `export const value${i} = ${i};\n`);
  }

  return { splitThreshold };
}

function commitGenerationResult(subject: string): {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
} {
  return {
    text: [subject, "", "- Add grouped files"].join("\n"),
    usage: {
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 130,
    },
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitCount(): number {
  return Number(git("rev-list", "--count", "HEAD"));
}

function lastSubjects(count: number): string[] {
  return git("log", `-${count}`, "--pretty=%s")
    .split("\n")
    .filter(Boolean);
}

function commitFiles(ref: string): string[] {
  return git("show", "--name-only", "--pretty=", ref)
    .split("\n")
    .filter(Boolean);
}
