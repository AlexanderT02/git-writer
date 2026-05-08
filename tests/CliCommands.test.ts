import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunCommitInteractive = vi.fn();
const mockRunPRInteractive = vi.fn();
const mockRenderStats = vi.fn();
const mockRenderReset = vi.fn();
const mockGetCurrentProvider = vi.fn();
const mockSetProvider = vi.fn();
const mockIsProviderName = vi.fn();
const mockAvailableProviders = vi.fn();

vi.mock("child_process", () => ({
  execFileSync: vi.fn(() => "ok"),
}));

vi.mock("../src/core/App.js", () => ({
  App: vi.fn().mockImplementation(() => ({
    runCommitInteractive: mockRunCommitInteractive,
    runPRInteractive: mockRunPRInteractive,
  })),
}));

vi.mock("../src/stats/StatsRenderer.js", () => ({
  StatsRenderer: vi.fn().mockImplementation(() => ({
    render: mockRenderStats,
    renderReset: mockRenderReset,
  })),
}));

vi.mock("../src/llm/ProviderSettings.js", () => ({
  ProviderSettings: vi.fn().mockImplementation(() => ({
    getCurrentProvider: mockGetCurrentProvider,
    setProvider: mockSetProvider,
    isProviderName: mockIsProviderName,
    availableProviders: mockAvailableProviders,
  })),
}));

vi.mock("../src/config/config.js", () => ({
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

  async function getCommandHelp(commandName: string): Promise<string> {
    const { createProgram } = await import("../src/index.js");

    const program = createProgram();

    const command = program.commands.find((cmd) => {
      return cmd.name() === commandName || cmd.aliases().includes(commandName);
    });

    if (!command) {
      throw new Error(`Command not found: ${commandName}`);
    }

    return command.helpInformation();
  }

  async function runCommand(args: string[]): Promise<CommandResult> {
    const { createProgram } = await import("../src/index.js");

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
      const { App } = await import("../src/core/App.js");

      await runCommand(["commit"]);

      expect(mockGetCurrentProvider).toHaveBeenCalledTimes(1);
      expect(App).toHaveBeenCalledWith(false, [], "openai");
      expect(mockRunCommitInteractive).toHaveBeenCalledTimes(1);
    });

    it("runs commit alias c", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["c"]);

      expect(mockGetCurrentProvider).toHaveBeenCalledTimes(1);
      expect(App).toHaveBeenCalledWith(false, [], "openai");
      expect(mockRunCommitInteractive).toHaveBeenCalledTimes(1);
    });

    it("runs commit with --force as fast commit mode", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["commit", "--force"]);

      expect(mockGetCurrentProvider).toHaveBeenCalledTimes(1);
      expect(App).toHaveBeenCalledWith(true, [], "openai");
      expect(mockRunCommitInteractive).toHaveBeenCalledTimes(1);
    });

    it("runs commit with -f as fast commit mode", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["commit", "-f"]);

      expect(mockGetCurrentProvider).toHaveBeenCalledTimes(1);
      expect(App).toHaveBeenCalledWith(true, [], "openai");
      expect(mockRunCommitInteractive).toHaveBeenCalledTimes(1);
    });

    it("passes normalized issue refs to commit", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["commit", "123", "   ", "456"]);

      expect(App).toHaveBeenCalledWith(false, ["123", "456"], "openai");
      expect(mockRunCommitInteractive).toHaveBeenCalledTimes(1);
    });

    it("passes normalized issue refs to forced commit", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["commit", "--force", "123", "   ", "456"]);

      expect(App).toHaveBeenCalledWith(true, ["123", "456"], "openai");
      expect(mockRunCommitInteractive).toHaveBeenCalledTimes(1);
    });
  });

  describe("pr", () => {
    it("runs pr command with current provider", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["pr"]);

      expect(mockGetCurrentProvider).toHaveBeenCalledTimes(1);
      expect(App).toHaveBeenCalledWith(false, [], "openai", false);
      expect(mockRunPRInteractive).toHaveBeenCalledWith(undefined);
    });

    it("runs pr alias p", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["p"]);

      expect(App).toHaveBeenCalledWith(false, [], "openai", false);
      expect(mockRunPRInteractive).toHaveBeenCalledWith(undefined);
    });

    it("runs pr alias pull-request", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["pull-request"]);

      expect(App).toHaveBeenCalledWith(false, [], "openai", false);
      expect(mockRunPRInteractive).toHaveBeenCalledWith(undefined);
    });

    it("passes base branch with --base", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["pr", "--base", "origin/develop"]);

      expect(App).toHaveBeenCalledWith(false, [], "openai", false);
      expect(mockRunPRInteractive).toHaveBeenCalledWith("origin/develop");
    });

    it("passes trimmed base branch with --base", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["pr", "--base", "  origin/develop  "]);

      expect(App).toHaveBeenCalledWith(false, [], "openai", false);
      expect(mockRunPRInteractive).toHaveBeenCalledWith("origin/develop");
    });

    it("passes base branch with -b", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["pr", "-b", "origin/main"]);

      expect(App).toHaveBeenCalledWith(false, [], "openai", false);
      expect(mockRunPRInteractive).toHaveBeenCalledWith("origin/main");
    });

    it("runs pr --auto in fast PR mode with confirmations", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["pr", "--auto"]);

      expect(App).toHaveBeenCalledWith(true, [], "openai", false);
      expect(mockRunPRInteractive).toHaveBeenCalledWith(undefined);
    });

    it("runs pr -a in fast PR mode with confirmations", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["pr", "-a"]);

      expect(App).toHaveBeenCalledWith(true, [], "openai", false);
      expect(mockRunPRInteractive).toHaveBeenCalledWith(undefined);
    });

    it("runs pr --force in fast PR mode without confirmations", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["pr", "--force"]);

      expect(App).toHaveBeenCalledWith(true, [], "openai", true);
      expect(mockRunPRInteractive).toHaveBeenCalledWith(undefined);
    });

    it("runs pr -f in fast PR mode without confirmations", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["pr", "-f"]);

      expect(App).toHaveBeenCalledWith(true, [], "openai", true);
      expect(mockRunPRInteractive).toHaveBeenCalledWith(undefined);
    });

    it("runs pr --force with base branch", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["pr", "--force", "--base", "origin/develop"]);

      expect(App).toHaveBeenCalledWith(true, [], "openai", true);
      expect(mockRunPRInteractive).toHaveBeenCalledWith("origin/develop");
    });

    it("treats --force as stronger than --auto", async () => {
      const { App } = await import("../src/core/App.js");

      await runCommand(["pr", "--auto", "--force"]);

      expect(App).toHaveBeenCalledWith(true, [], "openai", true);
      expect(mockRunPRInteractive).toHaveBeenCalledWith(undefined);
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

    it("shows force option in commit help", async () => {
      const output = await getCommandHelp("commit");

      expect(output).toContain("-f, --force");
      expect(output).toContain("Skip the interactive menu");
      expect(output).toContain("multiple logical commits");
    });

    it("shows auto and force options in pr help", async () => {
      const output = await getCommandHelp("pr");
      const normalizedOutput = output.replace(/\s+/g, " ");

      expect(normalizedOutput).toContain(
        "-a, --auto Auto mode: commit, push, and create PR with confirmations",
      );
      expect(normalizedOutput).toContain(
        "-f, --force Force mode: commit, push, and create PR without confirmations",
      );
    });
  });
});