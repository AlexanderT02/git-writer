import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRunCommitInteractive,
  mockRunPRInteractive,
  mockRenderStats,
  mockRenderReset,
  mockGetCurrentProvider,
  mockSetProvider,
  mockIsProviderName,
  mockAvailableProviders,
  mockExecFileSync,
  mockSpawnSync,
} = vi.hoisted(() => ({
  mockRunCommitInteractive: vi.fn(),
  mockRunPRInteractive: vi.fn(),
  mockRenderStats: vi.fn(),
  mockRenderReset: vi.fn(),
  mockGetCurrentProvider: vi.fn(),
  mockSetProvider: vi.fn(),
  mockIsProviderName: vi.fn(),
  mockAvailableProviders: vi.fn(),
  mockExecFileSync: vi.fn(() => "ok"),
  mockSpawnSync: vi.fn(() => ({
    status: 0,
    stdout: "ok",
    stderr: "",
    error: undefined,
  })),
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();

  return {
    ...actual,
    execFileSync: mockExecFileSync,
    spawnSync: mockSpawnSync,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    execFileSync: mockExecFileSync,
    spawnSync: mockSpawnSync,
  };
});

vi.mock("../../src/core/App.js", () => ({
  App: vi.fn().mockImplementation(() => ({
    runCommitInteractive: mockRunCommitInteractive,
    runPRInteractive: mockRunPRInteractive,
  })),
}));

vi.mock("../../src/stats/StatsRenderer.js", () => ({
  StatsRenderer: vi.fn().mockImplementation(() => ({
    render: mockRenderStats,
    renderReset: mockRenderReset,
  })),
}));

vi.mock("../../src/llm/ProviderSettings.js", () => ({
  ProviderSettings: vi.fn().mockImplementation(() => ({
    getCurrentProvider: mockGetCurrentProvider,
    setProvider: mockSetProvider,
    isProviderName: mockIsProviderName,
    availableProviders: mockAvailableProviders,
  })),
}));

vi.mock("../../src/config/config.js", () => ({
  config: {
    llm: {
      defaultProvider: "openai",
      providers: {
        openai: {
          reasoningModel: "gpt-4o-mini",
          generationModel: "gpt-5.4-mini",
        },
        ollama: {
          reasoningModel: "llama3.1",
          generationModel: "llama3.1",
        },
        gemini: {
          reasoningModel: "gemini-2.5-flash",
          generationModel: "gemini-2.5-flash-lite",
        },
      },
    },
  },
}));

type CommandResult = {
  stdout: string;
  stderr: string;
};

describe("CLI commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    mockGetCurrentProvider.mockReturnValue("openai");
    mockIsProviderName.mockImplementation((value: string) =>
      ["openai", "ollama", "gemini"].includes(value),
    );
    mockAvailableProviders.mockReturnValue(["openai", "ollama", "gemini"]);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  async function runCommand(args: string[]): Promise<CommandResult> {
    const { createProgram } = await import("../../src/index.js");

    const program = createProgram();

    const output: CommandResult = {
      stdout: "",
      stderr: "",
    };

    program.exitOverride();
    program.configureOutput({
      writeOut: (value) => {
        output.stdout += value;
      },
      writeErr: (value) => {
        output.stderr += value;
      },
    });

    try {
      await program.parseAsync(["node", "gw", ...args], {
        from: "node",
      });
    } catch (error) {
      Object.assign(error as object, { output });

      const commanderError = error as Error & {
        code?: string;
        exitCode?: number;
      };

      if (commanderError.exitCode === 0) {
        return output;
      }

      throw error;
    }

    return output;
  }

  async function expectCommandFailure(args: string[]): Promise<{
    error: Error & { output?: CommandResult };
    output: CommandResult;
  }> {
    try {
      await runCommand(args);
      throw new Error(`Expected command to fail: ${args.join(" ")}`);
    } catch (error) {
      const typedError = error as Error & { output?: CommandResult };

      return {
        error: typedError,
        output: typedError.output ?? { stdout: "", stderr: "" },
      };
    }
  }

  describe("commit", () => {
    it("runs commit command with current provider", async () => {
      const { App } = await import("../../src/core/App.js");

      await runCommand(["commit"]);

      expect(mockGetCurrentProvider).toHaveBeenCalledTimes(1);
      expect(App).toHaveBeenCalledWith(false, [], "openai");
      expect(mockRunCommitInteractive).toHaveBeenCalledTimes(1);
    });

    it("runs commit alias c", async () => {
      const { App } = await import("../../src/core/App.js");

      await runCommand(["c"]);

      expect(mockGetCurrentProvider).toHaveBeenCalledTimes(1);
      expect(App).toHaveBeenCalledWith(false, [], "openai");
      expect(mockRunCommitInteractive).toHaveBeenCalledTimes(1);
    });

    it("passes normalized issue refs to commit", async () => {
      const { App } = await import("../../src/core/App.js");

      await runCommand(["commit", "123", "   ", "456"]);

      expect(App).toHaveBeenCalledWith(false, ["123", "456"], "openai");
      expect(mockRunCommitInteractive).toHaveBeenCalledTimes(1);
    });
  });

  describe("pull-request", () => {
    it("runs pull-request command with current provider", async () => {
      const { App } = await import("../../src/core/App.js");

      await runCommand(["pull-request"]);

      expect(mockGetCurrentProvider).toHaveBeenCalledTimes(1);
      expect(App).toHaveBeenCalledWith(false, [], "openai", false);
      expect(mockRunPRInteractive).toHaveBeenCalledWith(undefined);
    });

    it("runs pull-request alias pr", async () => {
      const { App } = await import("../../src/core/App.js");

      await runCommand(["pr"]);

      expect(App).toHaveBeenCalledWith(false, [], "openai", false);
      expect(mockRunPRInteractive).toHaveBeenCalledWith(undefined);
    });

    it("passes base branch with --base", async () => {
      const { App } = await import("../../src/core/App.js");

      await runCommand(["pr", "--base", "origin/develop"]);

      expect(App).toHaveBeenCalledWith(false, [], "openai", false);
      expect(mockRunPRInteractive).toHaveBeenCalledWith("origin/develop");
    });

    it("passes trimmed base branch with --base", async () => {
      const { App } = await import("../../src/core/App.js");

      await runCommand(["pr", "--base", "  origin/develop  "]);

      expect(App).toHaveBeenCalledWith(false, [], "openai", false);
      expect(mockRunPRInteractive).toHaveBeenCalledWith("origin/develop");
    });

    it("passes base branch with -b", async () => {
      const { App } = await import("../../src/core/App.js");

      await runCommand(["pr", "-b", "origin/main"]);

      expect(App).toHaveBeenCalledWith(false, [], "openai", false);
      expect(mockRunPRInteractive).toHaveBeenCalledWith("origin/main");
    });

    it("rejects empty base branch with validation context", async () => {
      const { error } = await expectCommandFailure(["pr", "--base", ""]);

      expect(error.message).toContain('process.exit unexpectedly called with "1"');
      expect(mockRunPRInteractive).not.toHaveBeenCalled();
    });

    it("rejects invalid base branch starting with dash with validation context", async () => {
      const { error } = await expectCommandFailure(["pr", "--base", "-bad"]);

      expect(error.message).toContain('process.exit unexpectedly called with "1"');
      expect(mockRunPRInteractive).not.toHaveBeenCalled();
    });
  });

  describe("stats", () => {
    it("runs stats command", async () => {
      await runCommand(["stats"]);

      expect(mockRenderStats).toHaveBeenCalledWith(undefined);
      expect(mockRenderReset).not.toHaveBeenCalled();
    });

    it("runs stats alias s", async () => {
      await runCommand(["s"]);

      expect(mockRenderStats).toHaveBeenCalledWith(undefined);
    });

    it("passes stats period", async () => {
      await runCommand(["stats", "week"]);

      expect(mockRenderStats).toHaveBeenCalledWith("week");
    });

    it("runs stats reset before rendering", async () => {
      await runCommand(["stats", "month", "--reset"]);

      expect(mockRenderReset).toHaveBeenCalledTimes(1);
      expect(mockRenderStats).toHaveBeenCalledWith("month");

      expect(mockRenderReset.mock.invocationCallOrder[0]).toBeLessThan(
        mockRenderStats.mock.invocationCallOrder[0],
      );
    });
  });

  describe("provider", () => {
    it("gets active provider and prints matching models", async () => {
      mockGetCurrentProvider.mockReturnValue("gemini");

      await runCommand(["provider", "get"]);

      const printed = vi.mocked(console.log).mock.calls
        .map((call) => String(call[0] ?? ""))
        .join("\n");

      expect(mockGetCurrentProvider).toHaveBeenCalledTimes(1);
      expect(printed).toContain("Active provider:");
      expect(printed).toContain("gemini");
      expect(printed).toContain("Reasoning model:");
      expect(printed).toContain("gemini-2.5-flash");
      expect(printed).toContain("Generation model:");
      expect(printed).toContain("gemini-2.5-flash-lite");
      expect(printed).toContain(
        "Hint: To use different models, add a new provider profile in src/config/config.ts.",
      );
    });

    it("gets openai provider and prints openai models", async () => {
      mockGetCurrentProvider.mockReturnValue("openai");

      await runCommand(["provider", "get"]);

      const printed = vi.mocked(console.log).mock.calls
        .map((call) => String(call[0] ?? ""))
        .join("\n");

      expect(mockGetCurrentProvider).toHaveBeenCalledTimes(1);
      expect(printed).toContain("openai");
      expect(printed).toContain("gpt-4o-mini");
      expect(printed).toContain("gpt-5.4-mini");
    });

    it("sets active provider to gemini", async () => {
      await runCommand(["provider", "set", "gemini"]);

      expect(mockIsProviderName).toHaveBeenCalledWith("gemini");
      expect(mockSetProvider).toHaveBeenCalledWith("gemini");

      const printed = vi.mocked(console.log).mock.calls
        .map((call) => String(call[0] ?? ""))
        .join("\n");

      expect(printed).toContain("Active provider set to gemini");
    });

    it("sets active provider to openai", async () => {
      await runCommand(["provider", "set", "openai"]);

      expect(mockIsProviderName).toHaveBeenCalledWith("openai");
      expect(mockSetProvider).toHaveBeenCalledWith("openai");
    });

    it("sets active provider to ollama", async () => {
      await runCommand(["provider", "set", "ollama"]);

      expect(mockIsProviderName).toHaveBeenCalledWith("ollama");
      expect(mockSetProvider).toHaveBeenCalledWith("ollama");
    });

    it("rejects invalid provider with validation context", async () => {
      mockIsProviderName.mockReturnValue(false);

      const { error } = await expectCommandFailure([
        "provider",
        "set",
        "invalid",
      ]);

      expect(error.message).toContain('process.exit unexpectedly called with "1"');
      expect(mockIsProviderName).toHaveBeenCalledWith("invalid");
      expect(mockAvailableProviders).toHaveBeenCalled();
      expect(mockSetProvider).not.toHaveBeenCalled();
    });
  });

  describe("help", () => {
    it("renders help command h", async () => {
      const output = await runCommand(["h"]);

      expect(output.stdout).toContain("Usage:");
      expect(output.stdout).toContain("commit");
      expect(output.stdout).toContain("pr");
      expect(output.stdout).toContain("provider");
      expect(output.stdout).toContain("stats");
    });
  });
});