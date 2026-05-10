import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
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

type LLMUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type LLMResponse = {
  text: string;
  usage: LLMUsage;
};

type GitHubPreflightError =
  | null
  | {
      status: "not_pushed";
      message: string;
      suggestedCommand: string;
    }
  | {
      status: "already_exists";
      message: string;
      url: string;
    };

type CreatePullRequestResult = {
  status: "created";
  url: string;
};

type CompleteMock = Mock<(prompt: string) => Promise<LLMResponse>>;

type StreamMock = Mock<
  (prompt: string, onText?: (text: string) => void) => Promise<LLMResponse>
>;

type ClipboardWriteMock = Mock<(text: string) => Promise<void>>;

type GetPreflightErrorMock = Mock<
  (baseBranch: string) => GitHubPreflightError
>;

type CreatePullRequestMock = Mock<
  (
    baseBranch: string,
    title: string,
    body: string,
  ) => CreatePullRequestResult
>;

type PrActionMenuMock = Mock<() => Promise<"copy" | "create" | "cancel">>;

const mockLLM = {
  complete: vi.fn() as CompleteMock,
  stream: vi.fn() as StreamMock,
};

const mockClipboardWrite = vi.fn(async (_text: string) => undefined) as ClipboardWriteMock;

const mockGetPreflightError = vi.fn(
  (_baseBranch: string) => null,
) as GetPreflightErrorMock;

const mockCreatePullRequestFromCurrentBranch = vi.fn(
  (_baseBranch: string, _title: string, _body: string) => ({
    status: "created",
    url: "https://github.com/example/repo/pull/1",
  }),
) as CreatePullRequestMock;

const mockPrActionMenu = vi.fn(
  async () => "copy" as const,
) as PrActionMenuMock;

vi.mock("../src/llm/Factory.js", () => ({
  createLLMProvider: vi.fn(() => mockLLM),
}));

vi.mock("clipboardy", () => ({
  default: {
    write: mockClipboardWrite,
  },
}));

vi.mock("../src/git/GitHubCliService.js", () => ({
  GitHubCLIService: vi.fn().mockImplementation(() => ({
    getPreflightError: mockGetPreflightError,
    createPullRequestFromCurrentBranch: mockCreatePullRequestFromCurrentBranch,
  })),
}));

vi.mock("../src/ui/UI.js", () => ({
  UI: {
    selectBranch: vi.fn(),
    prActionMenu: mockPrActionMenu,

    renderPRPreview: vi.fn(),
    renderPRCreated: vi.fn(),
    renderCopied: vi.fn(),
    renderCancelled: vi.fn(),

    render: vi.fn(),
    actionMenu: vi.fn(),
    refineInput: vi.fn(),
    editMessage: vi.fn(),
    renderNothingToCommit: vi.fn(),
    renderCommitCreated: vi.fn(),
  },
}));

describe("PR flow integration", () => {
  let cwd: string;
  let repo: string;

  beforeEach(() => {
    cwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), "git-writer-pr-"));

    process.chdir(repo);

    git("init");
    git("config", "user.name", "Test User");
    git("config", "user.email", "test@example.com");

    writeFileSync("README.md", "# Test\n");
    git("add", "README.md");
    git("commit", "-m", "chore: initial commit");

    git("branch", "-M", "main");

    git("checkout", "-b", "feature/auth");
    writeFileSync(
      "auth.ts",
      [
        "export function login(username: string, password: string) {",
        "  return Boolean(username && password);",
        "}",
        "",
      ].join("\n"),
    );
    git("add", "auth.ts");
    git("commit", "-m", "feat: add login function");

    mockLLM.complete.mockReset();
    mockLLM.stream.mockReset();

    mockClipboardWrite.mockReset();
    mockGetPreflightError.mockReset();
    mockCreatePullRequestFromCurrentBranch.mockReset();
    mockPrActionMenu.mockReset();

    mockGetPreflightError.mockReturnValue(null);

    mockCreatePullRequestFromCurrentBranch.mockReturnValue({
      status: "created",
      url: "https://github.com/example/repo/pull/1",
    });

    mockPrActionMenu.mockResolvedValue("copy");

    mockLLM.complete.mockImplementation(async (prompt: string) => {
      if (prompt.includes("Return exactly this format:")) {
        return prMarkdownResponse();
      }

      return prReasoningResponse();
    });
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it("builds PR context, generates PR markdown via mocked LLM and copies it", async () => {
    const { App } = await import("../src/core/App.js");

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockGetPreflightError).toHaveBeenCalledWith("main");
    expect(mockPrActionMenu).toHaveBeenCalledTimes(1);

    expect(mockLLM.complete).toHaveBeenCalledTimes(2);
    expect(mockLLM.stream).not.toHaveBeenCalled();

    const reasoningPrompt = mockLLM.complete.mock.calls[0]?.[0];
    const generationPrompt = mockLLM.complete.mock.calls[1]?.[0];

    expect(reasoningPrompt).toContain("Branch: feature/auth");
    expect(reasoningPrompt).toContain("Commits:");
    expect(reasoningPrompt).toContain("feat: add login function");
    expect(reasoningPrompt).toContain("Diff preview");
    expect(reasoningPrompt).toContain("auth.ts");
    expect(reasoningPrompt).toContain("export function login");

    expect(generationPrompt).toContain("Return exactly this format:");
    expect(generationPrompt).toContain(
      "Main purpose: add authentication support.",
    );

    expect(mockClipboardWrite).toHaveBeenCalledTimes(1);
    expect(mockClipboardWrite).toHaveBeenCalledWith(expectedClipboardMarkdown());

    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();
  });

  it("creates a pull request through the GitHub CLI service when the create action is selected", async () => {
    const { App } = await import("../src/core/App.js");

    mockPrActionMenu.mockResolvedValueOnce("create");

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockClipboardWrite).not.toHaveBeenCalled();

    expect(mockCreatePullRequestFromCurrentBranch).toHaveBeenCalledTimes(1);
    expect(mockCreatePullRequestFromCurrentBranch).toHaveBeenCalledWith(
      "main",
      "Add authentication flow",
      expectedPRBody(),
    );
  });

  it("does not call the LLM when there are no PR changes against the base branch", async () => {
    const { App } = await import("../src/core/App.js");

    git("checkout", "main");
    git("checkout", "-b", "feature/empty");

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 1,
    } satisfies Partial<GracefulExit>);

    expect(mockLLM.complete).not.toHaveBeenCalled();
    expect(mockClipboardWrite).not.toHaveBeenCalled();
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();
  });

  it("does not call the LLM when GitHub CLI preflight fails", async () => {
    const { App } = await import("../src/core/App.js");

    mockGetPreflightError.mockReturnValueOnce({
      status: "not_pushed",
      message: 'Current branch "feature/auth" has no upstream branch.',
      suggestedCommand: "git push -u origin feature/auth",
    });

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 1,
    } satisfies Partial<GracefulExit>);

    expect(mockGetPreflightError).toHaveBeenCalledWith("main");
    expect(mockLLM.complete).not.toHaveBeenCalled();
    expect(mockClipboardWrite).not.toHaveBeenCalled();
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();
  });

  it("exits successfully without LLM calls when a pull request already exists", async () => {
    const { App } = await import("../src/core/App.js");

    mockGetPreflightError.mockReturnValueOnce({
      status: "already_exists",
      url: "https://github.com/example/repo/pull/123",
      message: "A pull request for the current branch already exists.",
    });

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockGetPreflightError).toHaveBeenCalledWith("main");
    expect(mockLLM.complete).not.toHaveBeenCalled();
    expect(mockClipboardWrite).not.toHaveBeenCalled();
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();
  });

  it("does not continue when PR reasoning generation fails", async () => {
    const { App } = await import("../src/core/App.js");

    mockLLM.complete.mockRejectedValueOnce(new Error("LLM reasoning failed"));

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toThrow(
      "LLM reasoning failed",
    );

    expect(mockLLM.complete).toHaveBeenCalledTimes(1);
    expect(mockClipboardWrite).not.toHaveBeenCalled();
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();
  });

  it("does not continue when PR markdown generation fails", async () => {
    const { App } = await import("../src/core/App.js");

    mockLLM.complete
      .mockResolvedValueOnce(prReasoningResponse())
      .mockRejectedValueOnce(new Error("LLM markdown failed"));

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toThrow(
      "LLM markdown failed",
    );

    expect(mockLLM.complete).toHaveBeenCalledTimes(2);
    expect(mockClipboardWrite).not.toHaveBeenCalled();
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();
  });

  it("records usage stats after a successful PR generation", async () => {
    const { App } = await import("../src/core/App.js");

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
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

    expect(entry.command).toBe("pr");
    expect(entry.provider).toBe("openai");
    expect(entry.success).toBe(true);
    expect(entry.fastMode).toBe(false);

    expect(entry.usedTokens).toBe(330);
    expect(entry.inputTokens).toBe(220);
    expect(entry.outputTokens).toBe(110);

    expect(entry.fileCount).toBe(1);
    expect(entry.additions).toBeGreaterThan(0);
    expect(entry.deletions).toBe(0);
    expect(entry.changedLines).toBe(entry.additions + entry.deletions);

    expect(entry.branch).toBe("feature/auth");

    expect(entry.llmCalls).toHaveLength(2);
    expect(entry.llmCalls[0].role).toBe("reasoning");
    expect(entry.llmCalls[1].role).toBe("generation");
  });
});

function prReasoningResponse(): LLMResponse {
  return {
    text: [
      "Main purpose: add authentication support.",
      "Key changes: added login function and exported auth entry point.",
      "Risks: low.",
    ].join("\n"),
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    },
  };
}

function prMarkdownResponse(): LLMResponse {
  return {
    text: [
      "TITLE:",
      "Add authentication flow",
      "",
      "BODY:",
      expectedPRBody(),
    ].join("\n"),
    usage: {
      inputTokens: 120,
      outputTokens: 60,
      totalTokens: 180,
    },
  };
}

function expectedPRBody(): string {
  return [
    "## Summary",
    "This PR adds the authentication flow.",
    "",
    "## Changes",
    "- Add login function",
    "- Expose authentication entry point",
    "",
    "## Risks",
    "- No major risks identified",
  ].join("\n");
}

function expectedClipboardMarkdown(): string {
  return ["Add authentication flow", "", expectedPRBody()].join("\n");
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}