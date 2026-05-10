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
import { GracefulExit, UserCancelledError } from "../src/errors.js";

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
      status: "not_pushed" | "unpushed_commits" | "gh_unauthenticated" | "gh_missing" | "failed";
      message: string;
      suggestedCommand?: string;
    }
  | {
      status: "already_exists";
      message: string;
      url?: string;
    }
  | {
      status: "created";
      url: string;
    };

type CreatePullRequestResult =
  | {
      status: "created";
      url: string;
    }
  | {
      status: "already_exists";
      message?: string;
      url?: string;
    }
  | {
      status: "not_pushed" | "unpushed_commits" | "gh_unauthenticated" | "gh_missing" | "failed";
      message?: string;
      suggestedCommand?: string;
    };

type UnpushedCommitsInfo = {
  hasUpstream: boolean;
  branch: string;
  upstream?: string;
  count: number;
  suggestedCommand?: string;
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

type UnpushedCommitsWarningMenuMock = Mock<
  (info: UnpushedCommitsInfo) => Promise<"push" | "continue" | "cancel">
>;

const mockLLM = {
  complete: vi.fn() as CompleteMock,
  stream: vi.fn() as StreamMock,
};

const mockClipboardWrite = vi.fn(
  async (_text: string) => undefined,
) as ClipboardWriteMock;

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

const mockUnpushedCommitsWarningMenu = vi.fn(
  async (_info: UnpushedCommitsInfo) => "continue" as const,
) as UnpushedCommitsWarningMenuMock;

const mockSelectBranch = vi.fn();

const mockRenderPRPreview = vi.fn();
const mockRenderPRCreated = vi.fn();
const mockRenderCopied = vi.fn();
const mockRenderCancelled = vi.fn();
const mockRenderPullRequestAlreadyExists = vi.fn();
const mockRenderNoPRChanges = vi.fn();
const mockRenderPRFailure = vi.fn();

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
    selectBranch: mockSelectBranch,
    prActionMenu: mockPrActionMenu,
    unpushedCommitsWarningMenu: mockUnpushedCommitsWarningMenu,

    renderPRPreview: mockRenderPRPreview,
    renderPRCreated: mockRenderPRCreated,
    renderCopied: mockRenderCopied,
    renderCancelled: mockRenderCancelled,
    renderPullRequestAlreadyExists: mockRenderPullRequestAlreadyExists,
    renderNoPRChanges: mockRenderNoPRChanges,
    renderPRFailure: mockRenderPRFailure,

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
  let tempDirs: string[];

  beforeEach(() => {
    cwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), "git-writer-pr-"));
    tempDirs = [repo];

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
    mockUnpushedCommitsWarningMenu.mockReset();
    mockSelectBranch.mockReset();

    mockRenderPRPreview.mockReset();
    mockRenderPRCreated.mockReset();
    mockRenderCopied.mockReset();
    mockRenderCancelled.mockReset();
    mockRenderPullRequestAlreadyExists.mockReset();
    mockRenderNoPRChanges.mockReset();
    mockRenderPRFailure.mockReset();

    mockGetPreflightError.mockReturnValue(null);

    mockCreatePullRequestFromCurrentBranch.mockReturnValue({
      status: "created",
      url: "https://github.com/example/repo/pull/1",
    });

    mockPrActionMenu.mockResolvedValue("copy");
    mockUnpushedCommitsWarningMenu.mockResolvedValue("continue");

    mockLLM.complete.mockImplementation(async (prompt: string) => {
      if (prompt.includes("Return exactly this format:")) {
        return prMarkdownResponse();
      }

      return prReasoningResponse();
    });
  });

  afterEach(() => {
    process.chdir(cwd);

    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates and copies PR markdown without running GitHub CLI create preflight", async () => {
    const { App } = await import("../src/core/App.js");

    mockGetPreflightError.mockReturnValueOnce({
      status: "not_pushed",
      message: 'Current branch "feature/auth" has no upstream branch.',
      suggestedCommand: "git push -u origin feature/auth",
    });

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockUnpushedCommitsWarningMenu).toHaveBeenCalledTimes(1);

    expect(mockGetPreflightError).not.toHaveBeenCalled();
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();

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

    expect(mockRenderCopied).toHaveBeenCalledWith("Copied PR to clipboard");
  });

  it("creates a pull request through the GitHub CLI service when create is selected", async () => {
    const { App } = await import("../src/core/App.js");

    mockPrActionMenu.mockResolvedValueOnce("create");

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockLLM.complete).toHaveBeenCalledTimes(2);

    expect(mockGetPreflightError).toHaveBeenCalledTimes(1);
    expect(mockGetPreflightError).toHaveBeenCalledWith("main");

    expect(mockClipboardWrite).not.toHaveBeenCalled();

    expect(mockCreatePullRequestFromCurrentBranch).toHaveBeenCalledTimes(1);
    expect(mockCreatePullRequestFromCurrentBranch).toHaveBeenCalledWith(
      "main",
      "Add authentication flow",
      expectedPRBody(),
    );

    expect(mockRenderPRCreated).toHaveBeenCalledWith(
      "https://github.com/example/repo/pull/1",
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

    expect(mockRenderNoPRChanges).toHaveBeenCalledWith("main");

    expect(mockLLM.complete).not.toHaveBeenCalled();
    expect(mockPrActionMenu).not.toHaveBeenCalled();
    expect(mockGetPreflightError).not.toHaveBeenCalled();
    expect(mockClipboardWrite).not.toHaveBeenCalled();
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();
  });

  it("checks GitHub CLI preflight only after create is selected", async () => {
    const { App } = await import("../src/core/App.js");

    mockPrActionMenu.mockResolvedValueOnce("create");

    mockGetPreflightError.mockReturnValueOnce({
      status: "not_pushed",
      message: 'Current branch "feature/auth" has no upstream branch.',
      suggestedCommand: "git push -u origin feature/auth",
    });

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 1,
    } satisfies Partial<GracefulExit>);

    expect(mockLLM.complete).toHaveBeenCalledTimes(2);

    expect(mockGetPreflightError).toHaveBeenCalledTimes(1);
    expect(mockGetPreflightError).toHaveBeenCalledWith("main");

    expect(mockRenderPRFailure).toHaveBeenCalledWith({
      status: "not_pushed",
      message: 'Current branch "feature/auth" has no upstream branch.',
      suggestedCommand: "git push -u origin feature/auth",
    });

    expect(mockClipboardWrite).not.toHaveBeenCalled();
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();
  });

  it("allows copying PR markdown even if GitHub CLI preflight would fail", async () => {
    const { App } = await import("../src/core/App.js");

    mockPrActionMenu.mockResolvedValueOnce("copy");

    mockGetPreflightError.mockReturnValueOnce({
      status: "not_pushed",
      message: 'Current branch "feature/auth" has no upstream branch.',
      suggestedCommand: "git push -u origin feature/auth",
    });

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockGetPreflightError).not.toHaveBeenCalled();
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();

    expect(mockLLM.complete).toHaveBeenCalledTimes(2);
    expect(mockClipboardWrite).toHaveBeenCalledTimes(1);
  });

  it("exits successfully when preflight reports that a pull request already exists after create is selected", async () => {
    const { App } = await import("../src/core/App.js");

    mockPrActionMenu.mockResolvedValueOnce("create");

    mockGetPreflightError.mockReturnValueOnce({
      status: "already_exists",
      url: "https://github.com/example/repo/pull/123",
      message: "A pull request for the current branch already exists.",
    });

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockLLM.complete).toHaveBeenCalledTimes(2);

    expect(mockGetPreflightError).toHaveBeenCalledWith("main");
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();

    expect(mockRenderPRCreated).toHaveBeenCalledWith(
      "https://github.com/example/repo/pull/123",
    );
  });

  it("does not continue when PR reasoning generation fails", async () => {
    const { App } = await import("../src/core/App.js");

    mockLLM.complete.mockRejectedValueOnce(new Error("LLM reasoning failed"));

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toThrow(
      "LLM reasoning failed",
    );

    expect(mockLLM.complete).toHaveBeenCalledTimes(1);

    expect(mockPrActionMenu).not.toHaveBeenCalled();
    expect(mockGetPreflightError).not.toHaveBeenCalled();
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

    expect(mockPrActionMenu).not.toHaveBeenCalled();
    expect(mockGetPreflightError).not.toHaveBeenCalled();
    expect(mockClipboardWrite).not.toHaveBeenCalled();
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();
  });

  it("cancels before PR generation when the unpushed warning is cancelled", async () => {
    const { App } = await import("../src/core/App.js");

    mockUnpushedCommitsWarningMenu.mockResolvedValueOnce("cancel");

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toBeInstanceOf(
      UserCancelledError,
    );

    expect(mockUnpushedCommitsWarningMenu).toHaveBeenCalledTimes(1);
    expect(mockRenderCancelled).toHaveBeenCalledTimes(1);

    expect(mockLLM.complete).not.toHaveBeenCalled();
    expect(mockPrActionMenu).not.toHaveBeenCalled();
    expect(mockGetPreflightError).not.toHaveBeenCalled();
    expect(mockClipboardWrite).not.toHaveBeenCalled();
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();
  });

  it("passes no-upstream branch info to the unpushed warning", async () => {
    const { App } = await import("../src/core/App.js");

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockUnpushedCommitsWarningMenu).toHaveBeenCalledTimes(1);

    const info = mockUnpushedCommitsWarningMenu.mock.calls[0]?.[0];

    expect(info).toMatchObject({
      hasUpstream: false,
      branch: "feature/auth",
      count: 0,
      suggestedCommand: "git push -u origin feature/auth",
    });
  });

  it("pushes and sets upstream when the unpushed warning action is push", async () => {
    const { App } = await import("../src/core/App.js");

    const remote = createBareRemote(tempDirs);
    git("remote", "add", "origin", remote);

    mockUnpushedCommitsWarningMenu.mockResolvedValueOnce("push");
    mockPrActionMenu.mockResolvedValueOnce("copy");

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    const upstream = git(
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    );

    expect(upstream).toBe("origin/feature/auth");

    expect(mockLLM.complete).toHaveBeenCalledTimes(2);
    expect(mockClipboardWrite).toHaveBeenCalledTimes(1);
  });

  it("cancels from the PR action menu after preview", async () => {
    const { App } = await import("../src/core/App.js");

    mockPrActionMenu.mockResolvedValueOnce("cancel");

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toBeInstanceOf(
      UserCancelledError,
    );

    expect(mockLLM.complete).toHaveBeenCalledTimes(2);
    expect(mockRenderPRPreview).toHaveBeenCalledTimes(1);
    expect(mockRenderCancelled).toHaveBeenCalledTimes(1);

    expect(mockClipboardWrite).not.toHaveBeenCalled();
    expect(mockGetPreflightError).not.toHaveBeenCalled();
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
  it("does not show unpushed warning when branch has upstream and no unpushed commits", async () => {
    const { App } = await import("../src/core/App.js");

    const remote = createBareRemote(tempDirs);
    git("remote", "add", "origin", remote);

    git("checkout", "main");
    git("push", "-u", "origin", "main");

    git("checkout", "feature/auth");
    git("push", "-u", "origin", "feature/auth");

    mockPrActionMenu.mockResolvedValueOnce("copy");

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockUnpushedCommitsWarningMenu).not.toHaveBeenCalled();
    expect(mockClipboardWrite).toHaveBeenCalledTimes(1);
  });

  it("warns when branch has upstream but contains unpushed commits", async () => {
    const { App } = await import("../src/core/App.js");

    const remote = createBareRemote(tempDirs);
    git("remote", "add", "origin", remote);

    git("checkout", "main");
    git("push", "-u", "origin", "main");

    git("checkout", "feature/auth");
    git("push", "-u", "origin", "feature/auth");

    writeFileSync("extra.ts", "export const extra = true;\n");
    git("add", "extra.ts");
    git("commit", "-m", "feat: add extra file");

    mockUnpushedCommitsWarningMenu.mockResolvedValueOnce("continue");

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockUnpushedCommitsWarningMenu).toHaveBeenCalledTimes(1);

    const info = mockUnpushedCommitsWarningMenu.mock.calls[0]?.[0];

    expect(info).toMatchObject({
      hasUpstream: true,
      branch: "feature/auth",
      upstream: "origin/feature/auth",
      count: 1,
      suggestedCommand: "git push",
    });
  });

  it("pushes current branch without setting upstream when upstream already exists", async () => {
    const { App } = await import("../src/core/App.js");

    const remote = createBareRemote(tempDirs);
    git("remote", "add", "origin", remote);

    git("checkout", "main");
    git("push", "-u", "origin", "main");

    git("checkout", "feature/auth");
    git("push", "-u", "origin", "feature/auth");

    writeFileSync("extra.ts", "export const extra = true;\n");
    git("add", "extra.ts");
    git("commit", "-m", "feat: add extra file");

    const localHead = git("rev-parse", "HEAD");

    mockUnpushedCommitsWarningMenu.mockResolvedValueOnce("push");
    mockPrActionMenu.mockResolvedValueOnce("copy");

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    const remoteHead = git("rev-parse", "origin/feature/auth");

    expect(remoteHead).toBe(localHead);
    expect(mockClipboardWrite).toHaveBeenCalledTimes(1);
  });

  it("renders already exists when create result reports existing PR without URL", async () => {
    const { App } = await import("../src/core/App.js");

    mockPrActionMenu.mockResolvedValueOnce("create");
    mockCreatePullRequestFromCurrentBranch.mockReturnValueOnce({
      status: "already_exists",
      message: "A pull request already exists.",
    });

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockGetPreflightError).toHaveBeenCalledTimes(1);
    expect(mockCreatePullRequestFromCurrentBranch).toHaveBeenCalledTimes(1);
    expect(mockRenderPullRequestAlreadyExists).toHaveBeenCalledTimes(1);
  });

  it("renders existing PR URL when create result reports already exists with URL", async () => {
    const { App } = await import("../src/core/App.js");

    mockPrActionMenu.mockResolvedValueOnce("create");
    mockCreatePullRequestFromCurrentBranch.mockReturnValueOnce({
      status: "already_exists",
      message: "A pull request already exists.",
      url: "https://github.com/example/repo/pull/222",
    });

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockRenderPRCreated).toHaveBeenCalledWith(
      "https://github.com/example/repo/pull/222",
    );
  });

  it("renders create failure with suggested command", async () => {
    const { App } = await import("../src/core/App.js");

    mockPrActionMenu.mockResolvedValueOnce("create");
    mockCreatePullRequestFromCurrentBranch.mockReturnValueOnce({
      status: "unpushed_commits",
      message: "Current branch has unpushed commits.",
      suggestedCommand: "git push",
    });

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 1,
    } satisfies Partial<GracefulExit>);

    expect(mockRenderPRFailure).toHaveBeenCalledWith({
      message: "Current branch has unpushed commits.",
      suggestedCommand: "git push",
    });
  });

  it("renders already exists when preflight reports existing PR without URL", async () => {
    const { App } = await import("../src/core/App.js");

    mockPrActionMenu.mockResolvedValueOnce("create");
    mockGetPreflightError.mockReturnValueOnce({
      status: "already_exists",
      message: "A pull request already exists.",
    });

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockRenderPullRequestAlreadyExists).toHaveBeenCalledTimes(1);
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();
  });

  it("does not ask for base branch selection when base branch is provided", async () => {
    const { App } = await import("../src/core/App.js");

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockSelectBranch).not.toHaveBeenCalled();
  });

  it("asks for base branch when no base branch argument is provided", async () => {
    const { App } = await import("../src/core/App.js");

    const tempDirs: string[] = [];
    const remote = createBareRemote(tempDirs);
    git("remote", "add", "origin", remote);

    git("checkout", "main");
    git("push", "-u", "origin", "main");

    git("checkout", "feature/auth");

    mockSelectBranch.mockResolvedValueOnce("origin/main");

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive()).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockSelectBranch).toHaveBeenCalledTimes(1);
    expect(mockLLM.complete).toHaveBeenCalledTimes(2);
  });

  it("bubbles clipboard errors and does not create a PR", async () => {
    const { App } = await import("../src/core/App.js");

    mockPrActionMenu.mockResolvedValueOnce("copy");
    mockClipboardWrite.mockRejectedValueOnce(new Error("clipboard unavailable"));

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toThrow(
      "clipboard unavailable",
    );

    expect(mockLLM.complete).toHaveBeenCalledTimes(2);
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();
  });
  
  it("exits successfully when preflight reports created PR", async () => {
    const { App } = await import("../src/core/App.js");

    mockPrActionMenu.mockResolvedValueOnce("create");
    mockGetPreflightError.mockReturnValueOnce({
      status: "created",
      url: "https://github.com/example/repo/pull/333",
    });

    const app = new App(false, [], "openai");

    await expect(app.runPRInteractive("main")).rejects.toMatchObject({
      code: 0,
    } satisfies Partial<GracefulExit>);

    expect(mockRenderPRCreated).toHaveBeenCalledWith(
      "https://github.com/example/repo/pull/333",
    );
    expect(mockCreatePullRequestFromCurrentBranch).not.toHaveBeenCalled();
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

function createBareRemote(tempDirs: string[]): string {
  const remote = mkdtempSync(join(tmpdir(), "git-writer-pr-remote-"));

  tempDirs.push(remote);

  execFileSync("git", ["init", "--bare", remote], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return remote;
}